use cadet::ingestors::teal::feed_play::PlayIngestor;
use chrono::{Duration, TimeZone, Utc};
use rocketman::{
    ingestion::LexiconIngestor,
    types::event::{Commit, Event, Kind, Operation},
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Deserialize)]
struct Scenario {
    name: String,
    plays: Vec<Play>,
}

#[derive(Deserialize)]
struct Play {
    namespace: String,
    key: String,
    seconds: i64,
    artist: String,
    recording: Option<u128>,
}

impl Play {
    fn event(&self, did: &str) -> Event<Value> {
        let collection = match self.namespace.as_str() {
            "alpha" => "fm.teal.alpha.feed.play",
            "stable" => "fm.teal.feed.play",
            _ => panic!("invalid fixture namespace"),
        };
        let time = Utc.with_ymd_and_hms(2026, 1, 12, 22, 24, 0).unwrap()
            + Duration::seconds(self.seconds);
        let mut record = json!({
            "$type": collection,
            "trackName": "Intro",
            "artists": [{"artistName": self.artist}],
            "duration": 30,
            "playedTime": time.to_rfc3339()
        });
        if let Some(id) = self.recording {
            record["recordingMbId"] = json!(format!("mbid:{}", Uuid::from_u128(id)));
        }
        Event {
            did: did.to_owned(),
            time_us: Some(1),
            kind: Kind::Commit,
            commit: Some(Commit {
                rev: "fixture-rev".to_owned(),
                operation: Operation::Create,
                collection: collection.to_owned(),
                rkey: self.key.clone(),
                record: Some(record),
                cid: Some(format!("bafy-{}-{}", self.namespace, self.key)),
            }),
            identity: None,
        }
    }
}

async fn snapshot(pool: &PgPool, did: &str) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT source_collection || ':' || rkey FROM plays WHERE did = $1 ORDER BY rkey",
    )
    .bind(did)
    .fetch_all(pool)
    .await?)
}

#[tokio::test]
#[ignore = "requires a disposable migrated PostgreSQL database"]
async fn compare_alpha_and_stable_ingestion() -> anyhow::Result<()> {
    let pool = PgPool::connect(&std::env::var("DATABASE_URL")?).await?;
    let ingestor = PlayIngestor::new(pool.clone());
    let scenarios: Vec<Scenario> = serde_json::from_str(include_str!("cadet-legacy-matrix.json"))?;

    for scenario in &scenarios {
        for reversed in [false, true] {
            let did = format!("did:web:cadet-matrix-{}.example.com", Uuid::new_v4().simple());
            let mut events: Vec<_> = scenario.plays.iter().map(|play| play.event(&did)).collect();
            if reversed {
                events.reverse();
            }
            for event in events {
                ingestor.ingest(event).await?;
            }
            println!(
                "MATRIX {}",
                json!({"name": scenario.name, "reversed": reversed, "rows": snapshot(&pool, &did).await?})
            );
        }
    }

    let did = format!("did:web:cadet-matrix-{}.example.com", Uuid::new_v4().simple());
    let alpha = &scenarios[0].plays[0];
    let stable = &scenarios[0].plays[1];
    ingestor.ingest(alpha.event(&did)).await?;
    ingestor.ingest(stable.event(&did)).await?;
    let after_copy = snapshot(&pool, &did).await?;

    let mut deletion = stable.event(&did);
    let commit = deletion.commit.as_mut().unwrap();
    commit.operation = Operation::Delete;
    commit.record = None;
    commit.cid = None;
    ingestor.ingest(deletion).await?;
    let after_delete = snapshot(&pool, &did).await?;

    ingestor.ingest(alpha.event(&did)).await?;
    let after_replay = snapshot(&pool, &did).await?;
    println!(
        "LIFECYCLE {}",
        json!({"after_copy": after_copy, "after_delete": after_delete, "after_alpha_replay": after_replay})
    );
    Ok(())
}
