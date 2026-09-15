import importlib.util, sys, types, time

# stub out paho + serial so the module imports without the real deps
paho = types.ModuleType("paho"); pm = types.ModuleType("paho.mqtt")
pmc = types.ModuleType("paho.mqtt.client")
class _C:
    def __init__(self,*a,**k): pass
    def will_set(self,*a,**k): pass
class _V: VERSION2 = 2
pmc.Client=_C; pmc.CallbackAPIVersion=_V
sys.modules.update({"paho":paho,"paho.mqtt":pm,"paho.mqtt.client":pmc})
ser_mod = types.ModuleType("serial")
class SerialException(Exception): pass
ser_mod.Serial=object; ser_mod.SerialException=SerialException
sys.modules["serial"]=ser_mod

spec = importlib.util.spec_from_file_location("z", "zeversolar_mqtt.py")
z = importlib.util.module_from_spec(spec); spec.loader.exec_module(z)

class FakeSerial:
    """Hands out bytes in scripted chunks, one chunk per read()."""
    def __init__(self, chunks): self.chunks=list(chunks); self.in_waiting=0
    def read(self, n):
        if self.chunks: return self.chunks.pop(0)
        time.sleep(0.05); return b""

def build(data, bad_sum=False):
    body = b"\xAA\x55" + (1).to_bytes(2,"little") + (1).to_bytes(2,"big") \
           + b"\x11\x02" + len(data).to_bytes(1,"big") + data
    cs = z.checksum(body)
    if bad_sum: cs = bytes([cs[0]^0xFF, cs[1]])
    return body + cs

def payload(total_hi=0, total_lo=37680, power=1234):
    vals = {0x00:285, 0x0D:812, 0x01:2410, 0x04:52, 0x42:2431,
            0x44:power, 0x47:total_hi, 0x48:total_lo, 0x4A:3}
    out = bytearray()
    for did in z.DATA_MAP:
        out += vals.get(did,0).to_bytes(2,"big")
    return bytes(out)

fails=[]
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ")+name+(("  "+str(extra)) if extra and not cond else ""))
    if not cond: fails.append(name)

good = build(payload())

# 1. clean frame in one chunk
f,r,_ = z.read_frame(FakeSerial([good]), 1.0)
check("clean frame accepted", f==good and r is None, r)

# 2. frame split across three chunks (the real-world TCP case)
f,r,_ = z.read_frame(FakeSerial([good[:4], good[4:20], good[20:]]), 2.0)
check("split frame reassembled", f==good and r is None, r)

# 3. leading garbage before the header
f,r,_ = z.read_frame(FakeSerial([b"\x00\xff\xaa\x13"+good]), 1.0)
check("resyncs past leading garbage", f==good and r is None, r)

# 4. truncated frame -> rejected, NOT parsed as short
f,r,_ = z.read_frame(FakeSerial([good[:-6]]), 0.6)
check("truncated frame rejected", f is None and "incomplete" in (r or ""), r)

# 5. bad checksum -> rejected
f,r,_ = z.read_frame(FakeSerial([build(payload(), bad_sum=True)]), 0.6)
check("bad checksum rejected", f is None and "checksum" in (r or ""), r)

# 6. nothing at all -> the 'asleep or link down' reason
f,r,_ = z.read_frame(FakeSerial([]), 0.4)
check("silence reported distinctly", f is None and "no bytes at all" in (r or ""), r)

# 7. a valid frame that arrives AFTER a corrupt one still gets through
f,r,_ = z.read_frame(FakeSerial([build(payload(), bad_sum=True), good]), 1.5)
check("recovers after a corrupt frame", f==good and r is None, r)

# 8. parse produces the right numbers
d,r = z.parse_frame(good)
check("parsed correctly", d and d["power"]==1234 and d["energy_total"]==3768.0
      and d["energy_today"]==8.12 and d["voltage_ac"]==243.1 and d["temperature"]==28.5, (d,r))

# 9. short payload -> refused, no zero-filling
d,r = z.parse_frame(build(payload()[:20]))
check("short payload refused", d is None and "need" in (r or ""), r)

# 10. energy_total 0 -> refused (the statistics-corrupting case)
d,r = z.parse_frame(build(payload(total_hi=0, total_lo=0)))
check("zero energy_total refused", d is None and "implausible" in (r or ""), r)

# 11. the old code's exact bug: a 12-byte runt must never yield a reading
runt = build(b"\x00\x01")
d,r = z.parse_frame(runt)
check("runt frame yields no data (old bug)", d is None, (d,r))

# --- 12-14. local RS485 echo (the 15 Sep fault) -----------------------------
# An auto-direction RS485 module hears its own transmission. The echo is a
# byte-perfect, checksum-valid frame, so without suppression it is returned as
# though the inverter had answered.
wake = z.construct_packet(z.MY_ADDRESS, 0x00, 0x10, 0x00)

# 12. echo alone must NOT be mistaken for a reply
f, r, raw = z.read_frame(FakeSerial([wake]), 0.4, echo=wake)
check("echo alone is not a reply", f is None and "echo" in (r or "").lower(), (f, r))

# 13. the diagnostic must report every byte received, not the post-discard tail
check("echo failure reports true byte count",
      f is None and len(raw) == len(wake) and str(len(wake)) in (r or ""), (r, raw))

# 14. a genuine reply arriving behind the echo must still be found
real = build(payload())
f, r, raw = z.read_frame(FakeSerial([wake, real]), 0.6, echo=wake)
check("reply behind the echo is found", f == real and r is None, (f, r))

# 15. without echo suppression the old behaviour is reproduced (guards the fix)
f, r, raw = z.read_frame(FakeSerial([wake]), 0.4)
check("no-echo-arg still returns the frame (back-compat)", f == wake and r is None, (f, r))

print("\nREQUIRED_DATA_BYTES =", z.REQUIRED_DATA_BYTES)
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
