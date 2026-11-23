"""Bug 1 — off-by-one in pagination.

The API is 1-based: page 1 is the first page. The slice below treats
``page`` as 0-based, so page 1 returns the second page of results.
"""


def page_slice(items, page, size):
    start = page * size
    return items[start:start + size]
