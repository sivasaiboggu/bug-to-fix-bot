"""Tests for the three seeded demo bugs.

Written against correct behaviour: each test FAILS on the buggy code
and PASSES after the patch. That is the whole point of the demo.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bugs"))

from bug1_pagination import page_slice
from bug2_profile import display_name
from bug3_pricing import total_price


def test_page_1_returns_first_items():
    assert page_slice(list(range(1, 11)), 1, 3) == [1, 2, 3]


def test_page_2_returns_next_items():
    assert page_slice(list(range(1, 11)), 2, 3) == [4, 5, 6]


def test_page_beyond_end_is_empty():
    assert page_slice(list(range(1, 11)), 5, 3) == []


def test_display_name_with_profile():
    assert display_name({"profile": {"name": "  Siva  "}}) == "Siva"


def test_display_name_without_profile_falls_back():
    assert display_name({"profile": None}) == "Unknown user"


def test_display_name_missing_profile_key_falls_back():
    assert display_name({}) == "Unknown user"


def test_total_price_sums_unit_price_times_qty():
    order = {"items": [{"unit_price": 100, "qty": 2}, {"unit_price": 50, "qty": 1}]}
    assert total_price(order) == 250


def test_total_price_empty_order_is_zero():
    assert total_price({"items": []}) == 0
