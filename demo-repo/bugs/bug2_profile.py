"""Bug 2 — None dereference in display name.

``user["profile"]`` is None for accounts that never filled in a
profile. Calling ``.strip()`` on it raises AttributeError.
"""


def display_name(user):
    return user["profile"]["name"].strip()
