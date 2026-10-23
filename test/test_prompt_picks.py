import random

from modules import prompt_parser


def expand(prompt, seed=0, index=0, kind="prompt"):
    return prompt_parser.expand_prompt_picks(prompt, prompt_parser.get_pick_rng(seed, index, kind))


def test_no_pick_is_left_untouched():
    assert expand("a photo of a cat, (sharp:1.2)") == "a photo of a cat, (sharp:1.2)"


def test_single_pick_returns_one_keyword():
    for index in range(20):
        assert expand("@PICK{red, green, blue}", index=index) in {"red", "green", "blue"}


def test_count_picks_that_many_keywords():
    keywords = {"red", "green", "blue", "black"}

    for index in range(20):
        picked = expand("@PICK(2){red, green, blue, black}", index=index).split(", ")
        assert len(picked) == 2
        assert len(set(picked)) == 2
        assert set(picked) <= keywords


def test_picked_keywords_keep_their_order():
    for index in range(20):
        picked = expand("@PICK(2){red, green, blue, black}", index=index).split(", ")
        assert picked == sorted(picked, key="red green blue black".split().index)


def test_count_is_clamped_to_the_keyword_count():
    assert expand("@PICK(9){red, green}") == "red, green"
    assert expand("@PICK(09){red, green}") == "red, green"


def test_a_zero_count_is_not_a_pick():
    # the grammar requires a count of at least 1, so the broken group stays literal
    assert expand("@PICK(0){red, green}") == "@PICK(0){red, green}"


def test_text_around_the_group_and_separators_survive():
    for index in range(20):
        prompt = expand("a photo of @PICK{red, green} car, best quality", index=index)
        assert prompt.startswith("a photo of ")
        assert prompt.endswith(" car, best quality")


def test_commas_inside_brackets_do_not_split_keywords():
    assert expand("@PICK(2){red (shiny, bright), green, <lora:x:1>}") in {
        "red (shiny, bright), green",
        "red (shiny, bright), <lora:x:1>",
        "green, <lora:x:1>",
    }


def test_nested_groups_are_picked_inside_out():
    assert expand("@pick{outer A, @pick{inner A, inner B}}", seed=3) in {
        "outer A",
        "inner A",
        "inner B",
    }


def test_tag_is_case_insensitive_and_allows_spaces():
    assert expand("@pick{a}") == "a"
    assert expand("@PICK ( 2 ) {a, b, c}").count(", ") == 1


def test_keyword_lists_may_span_lines():
    assert expand("@PICK(1){\n  red,\n  green\n}") in {"red", "green"}
    assert expand("@PICK(2){\n  red,\n  green,\n  blue\n}").count(", ") == 1


def test_broken_groups_stay_literal():
    assert expand("@PICK{a, b") == "@PICK{a, b"
    assert expand("@PICK{}") == "@PICK{}"


def test_draw_is_reproducible_and_per_batch_item():
    first = [expand("@PICK(2){a, b, c, d}", seed=1234, index=index) for index in range(16)]
    again = [expand("@PICK(2){a, b, c, d}", seed=1234, index=index) for index in range(16)]

    assert first == again, "the same seed and batch item must draw the same keywords"
    assert len(set(first)) > 1, "a batch has to draw again for every image"


def test_a_random_seed_draws_fresh_keywords():
    rng = random.Random()

    assert expand("@PICK{a, b, c}", seed=-1) in {"a", "b", "c"}
    assert prompt_parser.expand_prompt_picks("@PICK{a, b, c}", rng) in {"a", "b", "c"}


def test_split_pick_items_ignores_empty_keywords():
    assert prompt_parser.split_pick_items(" a, , b (x, y), ") == ["a", "b (x, y)"]
