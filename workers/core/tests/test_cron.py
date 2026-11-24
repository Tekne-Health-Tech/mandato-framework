"""Cron parser and due-minute computation (design 0004 §4, §9).

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import unittest
from datetime import datetime, timedelta, timezone

from workers.core.runtime.cron import CronError, due_minutes, parse

UTC = timezone.utc


def utc(*a):
    return datetime(*a, tzinfo=UTC)


class ParseTest(unittest.TestCase):
    def test_fields(self):
        s = parse("*/15 6-8 1,15 * 1-5")
        self.assertEqual(s.minute, {0, 15, 30, 45})
        self.assertEqual(s.hour, {6, 7, 8})
        self.assertEqual(s.dom, {1, 15})
        self.assertEqual(s.month, set(range(1, 13)))
        self.assertEqual(s.dow, {1, 2, 3, 4, 5})

    def test_range_with_step_and_sunday_as_7(self):
        s = parse("0 0 * * 5-7")
        self.assertEqual(s.dow, {5, 6, 0})
        self.assertEqual(parse("10-50/20 * * * *").minute, {10, 30, 50})

    def test_invalid_refused(self):
        for bad in ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *",
                    "* * * * 8", "*/0 * * * *", "5-1 * * * *", "MON * * * *", "* * L * *", "* * * * 1#2",
                    "1,,2 * * * *", "-1 * * * *", "1-2-3 * * * *", "*/x * * * *", "1/2 * * * *"]:
            with self.assertRaises(CronError, msg=bad):
                parse(bad)


class DueTest(unittest.TestCase):
    TZ = "America/Fortaleza"   # UTC-3, no DST

    def test_local_time(self):
        s = parse("0 6 * * *")   # 06:00 Fortaleza = 09:00 UTC
        got = due_minutes(s, self.TZ, utc(2026, 11, 24, 8, 58), utc(2026, 11, 24, 9, 2))
        self.assertEqual(got, [utc(2026, 11, 24, 9, 0)])

    def test_window_is_half_open(self):
        s = parse("* * * * *")
        got = due_minutes(s, self.TZ, utc(2026, 1, 1, 0, 0), utc(2026, 1, 1, 0, 3))
        self.assertEqual(got, [utc(2026, 1, 1, 0, 1), utc(2026, 1, 1, 0, 2), utc(2026, 1, 1, 0, 3)])

    def test_catch_up_capped_at_60_minutes(self):
        s = parse("* * * * *")
        now = utc(2026, 1, 1, 12, 0)
        got = due_minutes(s, self.TZ, now - timedelta(days=2), now)
        self.assertEqual(len(got), 60)
        self.assertEqual(got[0], now - timedelta(minutes=59))
        self.assertEqual(got[-1], now)

    def test_no_last_check_means_only_now(self):
        s = parse("* * * * *")
        now = utc(2026, 1, 1, 12, 0, 40)
        self.assertEqual(due_minutes(s, self.TZ, None, now), [utc(2026, 1, 1, 12, 0)])

    def test_dom_dow_either_when_both_restricted(self):
        s = parse("0 0 13 * 5")   # the 13th, or any Friday (local)
        start = utc(2026, 11, 1, 3, 0)
        days = []
        t = start
        while t < utc(2026, 12, 1, 3, 0):
            days += due_minutes(s, self.TZ, t, t + timedelta(minutes=60))
            t += timedelta(minutes=60)
        local = sorted({(d - timedelta(hours=3)).day for d in days})
        self.assertEqual(local, [6, 13, 20, 27])   # Nov 2026 Fridays are 6,13,20,27; 13th is also a Friday
        s2 = parse("0 0 1 * 5")
        days = []
        t = start
        while t < utc(2026, 12, 1, 3, 0):
            days += due_minutes(s2, self.TZ, t, t + timedelta(minutes=60))
            t += timedelta(minutes=60)
        self.assertEqual(sorted({(d - timedelta(hours=3)).day for d in days}), [1, 6, 13, 20, 27])

    def test_only_dow_restricted(self):
        s = parse("0 12 * * 0")   # Sundays at noon
        got = due_minutes(s, self.TZ, utc(2026, 11, 29, 14, 0), utc(2026, 11, 29, 15, 30))
        self.assertEqual(got, [utc(2026, 11, 29, 15, 0)])
        self.assertEqual(due_minutes(s, self.TZ, utc(2026, 11, 30, 14, 0), utc(2026, 11, 30, 15, 30)), [])

    def test_bad_timezone_refused(self):
        with self.assertRaises(CronError):
            due_minutes(parse("* * * * *"), "Nowhere/Land", None, utc(2026, 1, 1))


if __name__ == "__main__":
    unittest.main()
