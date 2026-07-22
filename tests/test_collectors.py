from lettermate.sources.cleaner import clean_html


def test_clean_html_removes_active_content_and_marks_links_safe():
    cleaned = clean_html(
        '<p onclick="steal()">Hello <a href="https://example.com" target="_blank">link</a>'
        '<script>alert(1)</script></p>'
    )

    assert "script" not in cleaned.lower()
    assert "onclick" not in cleaned.lower()
    assert 'rel="noopener noreferrer"' in cleaned
    assert "Hello" in cleaned
