package listenbrainz

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/teal-fm/piper/models"
)

func TestAuditEmptyLegacyListenBrainzKeys(t *testing.T) {
	for _, tc := range []struct {
		name            string
		legacyMBID      string
		newMapping      bool
		changeID        bool
		includeInferred bool
		reverse         bool
		want            int
		wantCandidate   int
	}{
		{name: "duplicate after mapping appears", newMapping: true, want: 2, wantCandidate: 1},
		{name: "different submitted ID lost with no mapping", changeID: true, want: 1, wantCandidate: 2},
		{name: "different submitted ID still visible with mapping", changeID: true, newMapping: true, want: 2, wantCandidate: 2},
		{name: "distinct inferred listen lost, explicit first", legacyMBID: "mapped-old", includeInferred: true, want: 1, wantCandidate: 2},
		{name: "distinct inferred listen lost, inferred first", legacyMBID: "mapped-old", includeInferred: true, reverse: true, want: 1, wantCandidate: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := testDatabase(t)
			user := linkedUser(t, database, "listener", "secret")
			timestamp, empty, submitted := int64(200), "", "submitted-recording"
			old := models.ListenBrainzPayload{
				ListenedAt: &timestamp,
				TrackMetadata: models.ListenBrainzTrackMetadata{
					ArtistName: "Artist", TrackName: "Song",
					AdditionalInfo: &models.ListenBrainzAdditionalInfo{
						RecordingMSID: &empty, RecordingMBID: &submitted,
					},
				},
			}
			if tc.legacyMBID != "" {
				old.TrackMetadata.MBIDMapping = &models.ListenBrainzMBIDMapping{RecordingMBID: tc.legacyMBID}
			}
			track := syncedTrack(&old)
			if _, err := database.SaveListenBrainzTrack(user.ID, listenIdentity(&old, tc.legacyMBID), &track); err != nil {
				t.Fatal(err)
			}

			explicit := old
			if tc.newMapping {
				explicit.TrackMetadata.MBIDMapping = &models.ListenBrainzMBIDMapping{RecordingMBID: "mapped-new"}
			}
			if tc.changeID {
				second := "different-submitted-recording"
				explicit.TrackMetadata.AdditionalInfo = &models.ListenBrainzAdditionalInfo{
					RecordingMSID: &empty, RecordingMBID: &second,
				}
			}
			listens := []models.ListenBrainzPayload{explicit}
			if tc.includeInferred {
				inferred := old
				inferred.TrackMetadata.AdditionalInfo = nil
				inferred.TrackMetadata.MBIDMapping = &models.ListenBrainzMBIDMapping{RecordingMBID: "mapped-new"}
				listens = append(listens, inferred)
				if tc.reverse {
					listens[0], listens[1] = listens[1], listens[0]
				}
			}
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"payload": map[string]any{"listens": listens}})
			}))
			defer server.Close()
			if err := testService(database, server, nil).syncListens(context.Background(), user); err != nil {
				t.Fatal(err)
			}
			tracks, err := database.GetRecentTracks(user.ID, 10)
			if err != nil {
				t.Fatal(err)
			}
			want := tc.want
			if os.Getenv("PIPER_REPLAY_CANDIDATE") == "1" {
				want = tc.wantCandidate
			}
			if len(tracks) != want {
				t.Fatalf("observed %d records, want %d", len(tracks), want)
			}
			t.Logf("stored records = %d", len(tracks))
		})
	}
}
