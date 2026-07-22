# LetterMate Eval Labeling Rubric

This rubric applies to public or synthetic evaluation records only. Every item and label
must carry the same non-empty `dataset_version`; JSONL loaders reject duplicate `item_id`
values. Do not put private notes, identifying personal data, or raw account data in labels.
Use `redaction_status: public` for fully public material and `sanitized` when sensitive
details were removed. `unredacted` labels are invalid.

## Relevance Grade

- Grade 0: Not useful for the stated preference profile. The item is off-topic, promotional,
  unsupported, or contains no actionable insight.
- Grade 1: Potentially useful, but the excerpt is incomplete, broad, or lacks enough evidence
  to recommend confidently.
- Grade 2: Directly useful and actionable from the available material. It clearly matches a
  preference and contains a concrete method, finding, or decision-relevant detail.

## Full Text and Tags

Set `needs_full_text` to `true` only when the excerpt is insufficient to decide whether the
item is worth recommending or to assign its intended grade. A Grade 1 item commonly needs
full text; a Grade 2 item can also need it when the excerpt establishes relevance but not
enough detail for a final recommendation. Use `false` when the excerpt already supports a
confident decision. `expected_tags` should contain concise, observable topic labels rather
than inferred personal attributes.

## Labeling Procedure

Read the source title and excerpt, select exactly one relevance grade, decide the
`needs_full_text` flag independently, then assign tags. Record no private rationale. A second
labeler resolves disagreements by applying this rubric to the same public or sanitized record.
