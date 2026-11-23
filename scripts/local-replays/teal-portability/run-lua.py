"""Run a Lua file using the Lua 5.4 shared library in Codex Cloud."""
import ctypes as ct
from ctypes.util import find_library
from pathlib import Path
import sys

lib = ct.CDLL(find_library("lua5.4") or "liblua5.4.so.0")
lib.luaL_newstate.restype = ct.c_void_p
lib.luaL_openlibs.argtypes = [ct.c_void_p]
lib.luaL_loadfilex.argtypes = [ct.c_void_p, ct.c_char_p, ct.c_char_p]
lib.lua_pcallk.argtypes = [ct.c_void_p, ct.c_int, ct.c_int, ct.c_int, ct.c_ssize_t, ct.c_void_p]
lib.lua_tolstring.argtypes = [ct.c_void_p, ct.c_int, ct.c_void_p]
lib.lua_tolstring.restype = ct.c_char_p
lib.lua_close.argtypes = [ct.c_void_p]
context = lib.luaL_newstate()
if not context:
    raise RuntimeError("Could not initialize Lua")
lib.luaL_openlibs(context)
try:
    status = lib.luaL_loadfilex(context, bytes(Path(sys.argv[1])), None)
    if status == 0:
        status = lib.lua_pcallk(context, 0, 0, 0, 0, None)
    if status:
        error = lib.lua_tolstring(context, -1, None)
        if error:
            print(error.decode(), file=sys.stderr)
        sys.exit(status)
finally:
    lib.lua_close(context)
