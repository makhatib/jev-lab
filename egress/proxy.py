"""Egress proxy for the agent's Chrome: public web only.

Chrome sits on internal-only Docker networks; this proxy is its only way out. For every connection it
resolves the host itself, refuses if ANY address is not globally routable (private, loopback,
link-local, reserved, IPv4 or IPv6), then connects to the exact address it checked. Re-resolving is
never trusted, so a DNS change between check and connect cannot reach the LAN.
Only ports 80 and 443. HTTP CONNECT (https, wss) and absolute-URI http requests.
"""

import asyncio
import ipaddress
import socket
import sys
import time
from urllib.parse import urlsplit

PORTS = {80, 443}
MAX_CONNS = 256
IDLE = 60
SEM = asyncio.Semaphore(MAX_CONNS)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


async def resolve_public(host, port):
    if port not in PORTS:
        raise PermissionError(f"port {port} not allowed")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise PermissionError("cannot resolve") from None
    addrs = [i[4][0].split("%")[0] for i in infos]
    if not addrs:
        raise PermissionError("no address")
    bad = [a for a in addrs if not ipaddress.ip_address(a).is_global]
    if bad:
        raise PermissionError(f"non-public address {bad[0]}")
    return infos[0][4][0], infos[0][0]


async def pipe(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def deny(writer, host, why):
    log("DENY", host, why)
    writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    try:
        await writer.drain()
    finally:
        writer.close()


async def handle(reader, writer):
    async with SEM:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        except Exception:
            writer.close()
            return
        line, _, rest = head.partition(b"\r\n")
        try:
            method, target, version = line.decode("latin-1").split(" ", 2)
        except ValueError:
            writer.close()
            return
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            host, port = host.strip("[]"), int(port or 443)
        else:
            u = urlsplit(target)
            if u.scheme != "http" or not u.hostname:
                return await deny(writer, target[:80], "only absolute http:// or CONNECT")
            host, port = u.hostname, u.port or 80
        try:
            ip, family = await resolve_public(host, port)
            up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port, family=family), 10)
        except PermissionError as e:
            return await deny(writer, host, str(e))
        except Exception as e:
            log("FAIL", host, type(e).__name__)
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            writer.close()
            return
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            u = urlsplit(target)
            path = (u.path or "/") + (("?" + u.query) if u.query else "")
            headers = [h for h in rest.split(b"\r\n") if h and not h.lower().startswith((b"proxy-", b"connection:"))]
            up_w.write(f"{method} {path} {version}\r\n".encode("latin-1") + b"\r\n".join(headers)
                       + b"\r\nConnection: close\r\n\r\n")
            await up_w.drain()
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3128
    server = await asyncio.start_server(handle, "0.0.0.0", port)
    log("egress proxy on", port)
    async with server:
        await server.serve_forever()


asyncio.run(main())
