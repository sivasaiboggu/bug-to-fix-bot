"""Bug 3 — wrong dict key in order totals.

Order items carry ``unit_price``, not ``price``. Summing ``price``
raises KeyError on every order.
"""


def total_price(order):
    return sum(item["price"] * item["qty"] for item in order["items"])
