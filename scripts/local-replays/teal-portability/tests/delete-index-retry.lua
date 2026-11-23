-- Model separate repository and index writes. The model assumes :delete()
-- commits to the repository before the SQL unindex step runs.
local function read(path)
  local file = assert(io.open(path))
  local value = file:read("*a")
  file:close()
  return value
end

local did = "did:example:listener"
local uri = "at://" .. did .. "/fm.teal.feed.play/3n2uig2ts5hpz"
local repo = {}
local index = {}
local failUnindex = false

local function seed()
  repo[uri] = {
    _uri = uri,
    delete = function(self) repo[self._uri] = nil end,
  }
  index[uri] = true
end

local env = setmetatable({
  input = { uri = uri },
  caller_did = did,
  Record = { load = function(key) return repo[key] end },
  db = { raw = function(sql, args)
    if not sql:find("DELETE FROM teal_plays", 1, true) then return end
    if failUnindex then error("simulated SQL failure after repo delete") end
    index[args[1]] = nil
  end },
}, { __index = _G })
assert(load(read("scripts/prelude.lua") .. "\n" .. read("scripts/fm.teal.site.deletePlay.lua"), "delete", "t", env))()

seed()
assert(env.handle().success)
assert(repo[uri] == nil and index[uri] == nil)
print("PASS delete removes both the record and its indexed copy")

seed()
failUnindex = true
local ok, errorMessage = pcall(env.handle)
assert(not ok and errorMessage:find("simulated SQL failure", 1, true))
assert(repo[uri] == nil and index[uri] == true)

failUnindex = false
local retry = env.handle()
assert(retry.error == "NotFound")
assert(index[uri] == true)
print("REPRODUCED retry returns NotFound without removing the stale index row")

env.action = "delete"
env.uri = uri
assert(load(read("scripts/prelude.lua") .. "\n" .. read("scripts/play.lua"), "record.index", "t", env))()
assert(env.handle())
assert(index[uri] == nil)
print("PASS a delivered record-delete event clears the stale index row")
