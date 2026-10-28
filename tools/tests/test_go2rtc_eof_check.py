"""Unit tests for tools/go2rtc_eof_check.py (stdlib only): python3 -m unittest tools/tests/test_go2rtc_eof_check.py"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("eof", os.path.join(HERE, "..", "go2rtc_eof_check.py"))

G = "2026-10-28 17:26:10.123 WARNING (MainThread) [homeassistant.components.go2rtc.server] 17:26:10.123 WRN github.com/AlexxIT/go2rtc/internal/streams/producer.go:170 > error=EOF url=ffmpeg:rtsp://****@192.168.0.20:81/%s\n"
S = "2026-10-28 17:26:11.000 ERROR (stream_worker) [homeassistant.components.stream.stream.camera.bi_%s] Error from stream worker: Stream ended; no additional packets\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.d.name, "ha.log")
        self.state = os.path.join(self.d.name, "state.json")
        os.environ["GO2RTC_EOF_LOG"] = self.log
        os.environ["GO2RTC_EOF_STATE"] = self.state
        self.m = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.m)
        open(self.log, "w").write("2026-10-28 00:00:00.000 INFO (MainThread) [x] start\n")

    def tearDown(self):
        self.d.cleanup()

    def append(self, s):
        with open(self.log, "a") as f:
            f.write(s)


class Matching(Base):
    def test_sub_cameras_match_frontgate_does_not(self):
        self.assertTrue(self.m.matches(G % "subfront"))
        self.assertTrue(self.m.matches(G % "subsideyard"))
        self.assertFalse(self.m.matches(G % "frontgate"))
        self.assertTrue(self.m.matches(S % "subfront"))
        self.assertFalse(self.m.matches(S % "frontgate"))

    def test_info_level_and_other_loggers_ignored(self):
        self.assertFalse(self.m.matches(G.replace("WARNING", "INFO") % "subfront"))
        self.assertFalse(self.m.matches("2026-10-28 17:00:00.000 WARNING (MainThread) [other] subfront broke\n"))


class Counting(Base):
    def test_first_run_baselines_to_zero_then_counts_only_new(self):
        self.append(G % "subfront" * 5)
        self.assertEqual(self.m.count_new(), 0)  # baseline, history not counted
        self.append((G % "subfront") * 2 + (G % "frontgate") * 50 + S % "subsideyard")
        self.assertEqual(self.m.count_new(), 3)
        self.assertEqual(self.m.count_new(), 0)  # nothing new

    def test_old_format_state_is_treated_as_missing(self):
        json.dump({"count": 646, "ts": 1}, open(self.state, "w"))
        self.append((G % "subfront") * 4)
        self.assertEqual(self.m.count_new(), 0)  # re-baselined, no spurious spike

    def test_partial_last_line_waits_for_next_poll(self):
        self.m.count_new()
        line = G % "subfront"
        self.append(line[:60])
        self.assertEqual(self.m.count_new(), 0)
        self.append(line[60:])
        self.assertEqual(self.m.count_new(), 1)

    def test_rotation_reads_new_file_from_start(self):
        self.append((G % "subfront") * 3)
        self.m.count_new()
        os.rename(self.log, self.log + ".1")
        open(self.log, "w").write((G % "subfront") * 2)
        self.assertEqual(self.m.count_new(), 2)

    def test_truncation_reads_from_start(self):
        self.append((G % "subfront") * 3)
        self.m.count_new()
        open(self.log, "w").write(G % "subfront")
        self.assertEqual(self.m.count_new(), 1)

    def test_missing_log_fails_closed(self):
        os.remove(self.log)
        with self.assertRaises(FileNotFoundError):
            self.m.count_new()  # __main__ wrapper turns this into "0" + stderr


if __name__ == "__main__":
    unittest.main()
