"""Minimal thread-safe CDP client over one browser WebSocket (flattened sessions).

Replaces browser-harness's `cdp()` helper so jev-ultrafast talks to the Chrome container.
"""

import itertools
import json
import os
import socket
import threading
import urllib.request

import websocket

CHROME_HOST = os.environ.get("CHROME_HOST", "chrome")
CHROME_PORT = int(os.environ.get("CHROME_PORT", "9222"))


class CDPError(RuntimeError):
    pass


class Client:
    def __init__(self):
        self.lock = threading.Lock()
        self.ws = None
        self.ids = itertools.count(1)
        self.pending = {}
        self.listeners = []  # callables(method, params, session_id)

    def connect(self):
        # Chrome only accepts an IP or localhost in the Host header.
        ip = socket.gethostbyname(CHROME_HOST)
        with urllib.request.urlopen(f"http://{ip}:{CHROME_PORT}/json/version", timeout=5) as r:
            url = json.load(r)["webSocketDebuggerUrl"]
        # Chrome reports its internal address; the container may expose it on another port (socat).
        url = f"ws://{ip}:{CHROME_PORT}/devtools" + url.split("/devtools", 1)[1]
        ws = websocket.create_connection(url, timeout=None, suppress_origin=True, max_size=None)
        self.ws = ws
        threading.Thread(target=self._read, args=(ws,), daemon=True).start()

    def _read(self, ws):
        while True:
            try:
                msg = json.loads(ws.recv())
            except Exception:
                for waiter in list(self.pending.values()):
                    waiter["error"] = "CDP connection closed"
                    waiter["event"].set()
                self.ws = None
                return
            if "id" in msg:
                waiter = self.pending.pop(msg["id"], None)
                if waiter:
                    waiter["msg"] = msg
                    waiter["event"].set()
            else:
                for fn in list(self.listeners):
                    try:
                        fn(msg.get("method"), msg.get("params", {}), msg.get("sessionId"))
                    except Exception:
                        pass

    def send(self, method, session_id=None, timeout=30, **params):
        if self.ws is None:
            self.connect()
        msg_id = next(self.ids)
        waiter = {"event": threading.Event()}
        self.pending[msg_id] = waiter
        body = {"id": msg_id, "method": method, "params": params}
        if session_id:
            body["sessionId"] = session_id
        with self.lock:
            self.ws.send(json.dumps(body))
        if not waiter["event"].wait(timeout):
            self.pending.pop(msg_id, None)
            raise CDPError(f"CDP timeout: {method}")
        if waiter.get("error"):
            raise CDPError(waiter["error"])
        msg = waiter["msg"]
        if "error" in msg:
            raise CDPError(f"{method}: {msg['error'].get('message')}")
        return msg.get("result", {})


CLIENT = Client()


def cdp(method, session_id=None, **params):
    return CLIENT.send(method, session_id=session_id, **params)
