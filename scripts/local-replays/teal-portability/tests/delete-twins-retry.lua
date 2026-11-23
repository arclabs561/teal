-- Simulate user-repository writes and the site's SQL projection independently.
local function read(path)
  local file = assert(io.open(path))
  local value = file:read("*a")
  file:close()
  return value
end
local prelude = read("scripts/prelude.lua")
local delete = read("scripts/fm.teal.site.deletePlay.lua")
local index_event = read("scripts/play.lua")

local did = "did:example:listener"
local rkey = "3n2uig2ts5hpz"
local alpha = "fm.teal.alpha.feed.play"
local stable = "fm.teal.feed.play"
local function uri(collection)
  return "at://" .. did .. "/" .. collection .. "/" .. rkey
end

local function run(first, fault)
  local second = first == stable and alpha or stable
  local repo = {}
  local projected = uri(stable)
  local pending = {}
  local fail = true
  local function event(collection)
    local key = uri(collection)
    table.insert(pending, key)
  end
  for _, collection in ipairs({ stable, alpha }) do
    local key = uri(collection)
    repo[key] = {
      _uri = key,
      delete = function()
        if fail and fault == "repo-second" and collection == second then
          error("simulated second repository delete failure")
        end
        repo[key] = nil
        event(collection)
      end,
    }
  end
  local env = setmetatable({
    input = { uri = uri(stable) },
    caller_did = did,
    Record = { load = function(key) return repo[key] end },
    pairs = function(value)
      -- Exercise both enumeration orders of own_plays().
      if value[stable] == true and value[alpha] == true then
        return coroutine.wrap(function()
          coroutine.yield(first, true)
          coroutine.yield(second, true)
        end)
      end
      return pairs(value)
    end,
    db = { raw = function(sql, args)
      if not sql:find("DELETE FROM teal_plays", 1, true) then return end
      if fail and fault == "stable-sql" and args[1] == uri(stable) then
        error("simulated projection delete failure")
      end
      if projected == args[1] then projected = nil end
    end },
  }, { __index = _G })
  local function invoke(source)
    assert(load(prelude .. "\n" .. source, fault, "t", env))()
    return env.handle()
  end

  local ok, reason = pcall(invoke, delete)
  assert(not ok and reason:find("simulated", 1, true))
  fail = false
  local retry = invoke(delete)
  assert(repo[uri(stable)] == nil and repo[uri(alpha)] == nil)

  if fault == "stable-sql" then
    assert(projected == uri(stable))
    assert(retry.success == true or retry.error == "NotFound")
  else
    assert(projected == nil and retry.success == true)
  end
  print("PASS", first, fault, retry.success and "retry success" or retry.error,
    projected and "stale row" or "projection clean")

  -- A repeated delivered event should be safe too.
  for _, key in ipairs(pending) do
    env.action = "delete"
    env.uri = key
    assert(invoke(index_event))
    assert(invoke(index_event))
  end
  assert(projected == nil)
end

for _, first in ipairs({ stable, alpha }) do
  run(first, "repo-second")
  run(first, "stable-sql")
end
print("PASS replayed delete events reconciled both orderings")
