-- Run from apps/site/happyview with lua tests/portable-play.lua.
-- HappyView prepends prelude.lua to each handler. Its Record and SQL APIs are
-- replaced here so the real edit and delete logic runs without a live PDS.
local function source(name)
  local file = assert(io.open("scripts/" .. name .. ".lua"))
  local contents = file:read("*a")
  file:close()
  return contents
end

local recording = "00000000-0000-4000-8000-000000000001"
local release = "00000000-0000-4000-8000-000000000002"
local track = "00000000-0000-4000-8000-000000000003"
local apple = "https://music.apple.com/us/album/test/42?i=99"
local owner = "did:example:listener"
local rkey = "3n2uig2ts5hpz"
local prefix = source("prelude")
local update = source("fm.teal.site.updatePlay")
local remove = source("fm.teal.site.deletePlay")

local function replay(label, origin, recordingId, releaseId, editRecording, editRelease, expectedTrack)
  local records, writes, deletes, queries = {}, {}, {}, {}
  local function uri(collection) return "at://" .. owner .. "/" .. collection .. "/" .. rkey end
  for _, collection in ipairs({ "fm.teal.feed.play", "fm.teal.alpha.feed.play" }) do
    local key = uri(collection)
    records[key] = {
      ["$type"] = collection, _uri = key, _cid = "fixture",
      trackName = "Song", releaseName = "Release", artists = {{ artistName = "Artist" }},
      playedTime = "2026-11-22T01:42:45Z", musicServiceUri = "https://music.apple.com",
      originUri = origin, recordingMbId = recordingId, releaseMbId = releaseId,
      trackMbId = recordingId and "mbid:" .. track or nil,
      save = function(self) writes[self._uri] = true end,
      delete = function(self) deletes[self._uri] = true end,
    }
  end
  local stable = uri("fm.teal.feed.play")
  local input = { uri = stable, trackName = "Corrected song", artists = {{name = "Artist"}},
    releaseName = "Release", recordingMbId = editRecording, releaseMbId = editRelease }
  local env = setmetatable({
    input = input, caller_did = owner, json = {null = {}}, toarray = function(v) return v end,
    Record = {load = function(key) return records[key] end},
    db = {raw = function(q, args) table.insert(queries, {q, args}) end},
  }, {__index = _G})
  local function invoke(handler)
    assert(load(prefix .. "\n" .. handler, label, "t", env))()
    return env.handle()
  end
  assert(invoke(update).uri == stable)
  local function afterEdit(old, edited)
    if edited == "" then return nil end
    if edited then return "mbid:" .. edited end
    return old
  end
  for key, r in pairs(records) do
    assert(writes[key] and r.originUri == origin and r.musicServiceUri == "https://music.apple.com")
    assert(r.trackName == input.trackName and r.playedTime == "2026-11-22T01:42:45Z")
    assert(r.recordingMbId == afterEdit(recordingId, editRecording))
    assert(r.releaseMbId == afterEdit(releaseId, editRelease))
    assert(r.trackMbId == expectedTrack)
  end
  assert(#queries == 2)
  assert(invoke(remove).success)
  for key in pairs(records) do assert(deletes[key]) end
  assert(#queries == 4)
  print("PASS " .. label)
end

replay("source album URL only", apple, nil, nil, "", "", nil)
replay("no source identifier", nil, nil, nil, "", "", nil)
replay("keep track on a text-only correction", apple, "mbid:" .. recording, "mbid:" .. release, nil, nil, "mbid:" .. track)
replay("correct the edition and clear the obsolete track ID", apple, "mbid:" .. recording, nil, recording, release, nil)
replay("unlink a release and preserve the original source", apple, "mbid:" .. recording, "mbid:" .. release, recording, "", nil)
