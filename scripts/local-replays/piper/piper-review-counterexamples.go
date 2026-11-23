package listenbrainz

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/teal-fm/piper/models"
)

func TestReviewLegacyExplicitListenDoesNotIdentifyMappedListen(t *testing.T) {
	database := testDatabase(t)
	user := linkedUser(t, database, "listener", "secret")
	timestamp, explicit := int64(200), "submitted-recording"
	old := models.ListenBrainzPayload{
		ListenedAt: &timestamp,
		TrackMetadata: models.ListenBrainzTrackMetadata{
			TrackName: "Song", ArtistName: "Artist",
			AdditionalInfo: &models.ListenBrainzAdditionalInfo{RecordingMBID: &explicit},
		},
	}
	stored := syncedTrack(&old)
	legacyKey := fmt.Sprintf("%x", sha256.Sum256([]byte("200\x00Artist\x00Song\x00\x00submitted-recording")))
	if _, err := database.SaveListenBrainzTrack(user.ID, legacyKey, &stored); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"payload":{"listens":[
		  {"listened_at":200,"track_metadata":{"track_name":"Song","artist_name":"Artist","additional_info":{"recording_mbid":"submitted-recording"}}},
		  {"listened_at":200,"track_metadata":{"track_name":"Song","artist_name":"Artist","mbid_mapping":{"recording_mbid":"mapped-recording"}}}
		]}}`))
	}))
	defer server.Close()
	if err := testService(database, server, nil).syncListens(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	tracks, err := database.GetRecentTracks(user.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	want, err := strconv.Atoi(os.Getenv("PIPER_EXPECT_IMPORT_COUNT"))
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != want {
		t.Fatalf("distinct plays with different recordings stored = %d, want %d", len(tracks), want)
	}
	t.Logf("distinct plays with different recordings stored = %d", len(tracks))
}

type reviewPlayingNow struct {
	name string
	fail bool
}

func (p *reviewPlayingNow) PublishPlayingNow(_ context.Context, _ int64, track *models.Track) error {
	p.name = track.Name
	return nil
}

func (p *reviewPlayingNow) ClearPlayingNow(_ context.Context, _ int64) error {
	if p.fail {
		p.fail = false
		return errors.New("temporary status write failure")
	}
	p.name = ""
	return nil
}

func TestReviewRetryClearsNewerProviderStatus(t *testing.T) {
	database := testDatabase(t)
	user := linkedUser(t, database, "listener", "secret")
	polls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polls++
		if polls == 1 {
			w.Write([]byte(`{"payload":{"listens":[{"track_metadata":{"track_name":"ListenBrainz song","artist_name":"Artist"}}]}}`))
			return
		}
		w.Write([]byte(`{"payload":{"listens":[]}}`))
	}))
	defer server.Close()
	publisher := &reviewPlayingNow{fail: true}
	service := testService(database, server, publisher)
	ctx := context.Background()
	if err := service.syncPlayingNow(ctx, user); err != nil {
		t.Fatal(err)
	}
	if err := service.syncPlayingNow(ctx, user); err == nil {
		t.Fatal("expected the first clear to fail")
	}
	if err := publisher.PublishPlayingNow(ctx, user.ID, &models.Track{Name: "Spotify song"}); err != nil {
		t.Fatal(err)
	}
	if err := service.syncPlayingNow(ctx, user); err != nil {
		t.Fatal(err)
	}
	if want := os.Getenv("PIPER_EXPECT_NOW_PLAYING"); publisher.name != want {
		t.Fatalf("status after retry = %q, want %q", publisher.name, want)
	}
	t.Logf("status after retry = %q", publisher.name)
}
