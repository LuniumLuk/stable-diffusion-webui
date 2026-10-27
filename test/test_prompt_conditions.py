from modules import prompt_parser

STAGES = ("txt2img", "hires_fix", "img2img", "inpaint", "pose_inpaint")


def expand(prompt, stage=None, **kwargs):
    return prompt_parser.expand_prompt_conditions(prompt, prompt_parser.stage_macros(stage, **kwargs))


def content(prompt, stage=None, **kwargs):
    """The text the model sees: the resolved prompt without its directive lines."""
    return prompt_parser.strip_condition_directives(expand(prompt, stage, **kwargs))


BRANCH = "#if TXT2IMG\ntxt2img text\n#elseif HIRES_FIX\nhires text\n#else\nimg2img text\n#endif"


def test_no_block_is_left_untouched():
    assert expand("a photo of a cat, (sharp:1.2)") == "a photo of a cat, (sharp:1.2)"


def test_each_stage_takes_its_own_branch():
    assert content(BRANCH, "txt2img") == "txt2img text"
    assert content(BRANCH, "hires_fix") == "hires text"
    assert content(BRANCH, "img2img") == "img2img text"
    assert content(BRANCH, "inpaint") == "img2img text"
    assert content(BRANCH, "pose_inpaint") == "img2img text"
    assert content(BRANCH) == "img2img text"


def test_the_resolved_prompt_keeps_the_directives():
    assert expand(BRANCH, "txt2img") == "#if TXT2IMG\ntxt2img text\n#elseif HIRES_FIX\n#else\n#endif"
    assert expand(BRANCH, "hires_fix") == "#if TXT2IMG\n#elseif HIRES_FIX\nhires text\n#else\n#endif"
    assert expand(BRANCH, "img2img") == "#if TXT2IMG\n#elseif HIRES_FIX\n#else\nimg2img text\n#endif"
    for stage in STAGES:
        resolved = expand(BRANCH, stage)
        assert "#if TXT2IMG" in resolved
        assert "#elseif HIRES_FIX" in resolved
        assert "#else" in resolved
        assert resolved.endswith("#endif")
        assert "txt2img text" not in resolved or stage == "txt2img"


def test_a_resolved_prompt_can_be_resolved_again():
    for stage in STAGES:
        once = expand(BRANCH, stage)
        assert expand(once, stage) == once


def test_hires_fix_is_an_img2img_pass():
    macros = prompt_parser.stage_macros("hires_fix")
    assert macros["HIRES_FIX"] == 1
    assert macros["IMG2IMG"] == 1
    assert macros["TXT2IMG"] == 0
    assert macros["INPAINT"] == 0


def test_pose_inpaint_is_an_inpaint_pass():
    macros = prompt_parser.stage_macros("pose_inpaint")
    assert macros["POSE_INPAINT"] == 1
    assert macros["INPAINT"] == 1
    assert macros["IMG2IMG"] == 1
    assert macros["TXT2IMG"] == 0


def test_img2img_becomes_inpaint_when_a_mask_is_present():
    assert prompt_parser.stage_macros("img2img", inpaint=True)["INPAINT"] == 1
    assert prompt_parser.stage_macros("img2img", inpaint=False)["INPAINT"] == 0


def test_the_else_branch_is_only_taken_when_no_condition_matched():
    prompt = "#if INPAINT\ninpaint\n#else\nother\n#endif"
    assert content(prompt, "inpaint") == "inpaint"
    assert content(prompt, "txt2img") == "other"
    assert expand(prompt, "inpaint") == "#if INPAINT\ninpaint\n#else\n#endif"
    assert expand(prompt, "txt2img") == "#if INPAINT\n#else\nother\n#endif"


def test_blocks_may_be_nested():
    prompt = "#if TXT2IMG\na\n#if IMG2IMG\nb\n#else\nc\n#endif\nd\n#endif"
    assert content(prompt, "txt2img") == "a\nc\nd"
    assert content(prompt, "hires_fix") == ""
    assert content(prompt, "img2img") == ""
    # the outer block keeps its skeleton, the inner one lived in a dropped branch
    assert expand(prompt, "hires_fix") == "#if TXT2IMG\n#endif"
    assert expand(prompt, "txt2img") == "#if TXT2IMG\na\n#if IMG2IMG\n#else\nc\n#endif\nd\n#endif"


def test_a_block_inside_a_dropped_branch_loses_its_directives():
    prompt = "#if TXT2IMG\na\n#if IMG2IMG\nb\n#endif\n#endif\ncat"
    assert expand(prompt, "img2img") == "#if TXT2IMG\n#endif\ncat"
    assert expand(prompt, "txt2img") == "#if TXT2IMG\na\n#if IMG2IMG\n#endif\n#endif\ncat"


def test_negation_and_boolean_operators():
    assert content("#if !TXT2IMG\nx\n#endif", "txt2img") == ""
    assert content("#if TXT2IMG && !INPAINT\nx\n#endif", "txt2img") == "x"
    assert content("#if INPAINT || POSE_INPAINT\nx\n#endif", "inpaint") == "x"
    assert content("#if (TXT2IMG or IMG2IMG) and !HIRES_FIX\nx\n#endif", "img2img") == "x"
    assert content("#if (TXT2IMG or IMG2IMG) and !HIRES_FIX\nx\n#endif", "hires_fix") == ""


def test_pose_part_enum():
    hands = "#if POSE_INPAINT_PART == HANDS\nhands\n#endif"
    assert content(hands, "pose_inpaint", pose_part="left_hand") == "hands"
    assert content(hands, "pose_inpaint", pose_part="FACE") == ""
    assert content(hands, "txt2img") == ""

    face = "#if POSE_INPAINT_PART == FACE\nface\n#else\nother\n#endif"
    assert content(face, "pose_inpaint", pose_part="face") == "face"
    assert content(face, "pose_inpaint", pose_part="right_foot") == "other"
    assert content(face, "txt2img") == "other"

    assert content("#if POSE_INPAINT_PART != FEET\nx\n#endif", "pose_inpaint", pose_part="HANDS") == "x"
    assert content("#if POSE_INPAINT_PART == 0\nnone\n#endif", "txt2img") == "none"
    assert content("#if POSE_INPAINT_PART == NONE\nnone\n#endif", "txt2img") == "none"


def test_pose_inpaint_part_mapping():
    assert prompt_parser.pose_inpaint_part(None) == 0
    assert prompt_parser.pose_inpaint_part("Face") == "FACE"
    assert prompt_parser.pose_inpaint_part("hands") == "HANDS"
    assert prompt_parser.pose_inpaint_part("left_foot") == "FEET"
    assert prompt_parser.pose_inpaint_part("all") == 0
    assert prompt_parser.pose_inpaint_part("nonsense") == 0


def test_an_unknown_macro_counts_as_false():
    assert content("#if NOPE\na\n#else\nb\n#endif", "txt2img") == "b"


def test_a_broken_expression_counts_as_false():
    for condition in ("TXT2IMG ==", "(TXT2IMG", "TXT2IMG &"):
        assert content(f"#if {condition}\na\n#else\nb\n#endif", "txt2img") == "b"


def test_a_block_that_is_not_closed_stays_as_typed():
    assert expand("#if TXT2IMG\na", "txt2img") == "#if TXT2IMG\na"
    assert expand("#if TXT2IMG\n#if IMG2IMG\na\n#endif", "txt2img") == "#if TXT2IMG\n#if IMG2IMG\na\n#endif"


def test_stray_directives_stay_as_typed():
    assert expand("#else\na", "txt2img") == "#else\na"
    assert expand("#endif\na", "txt2img") == "#endif\na"
    assert expand("#if TXT2IMG\n#else\na\n#else\nb\n#endif", "txt2img") == "#if TXT2IMG\n#else\na\n#else\nb\n#endif"


def test_directives_need_a_line_of_their_own():
    prompt = "a, #if TXT2IMG x #endif b"
    assert expand(prompt, "txt2img") == prompt
    assert expand("#iffy TXT2IMG\na\n#endif", "txt2img") == "#iffy TXT2IMG\na\n#endif"


def test_comments_and_text_of_the_other_branches():
    prompt = "#if TXT2IMG\nbest quality, # a note\n#else\nlow quality\n#endif\nsharp focus"
    assert expand(prompt, "txt2img") == "#if TXT2IMG\nbest quality, # a note\n#else\n#endif\nsharp focus"
    assert content(prompt, "hires_fix") == "low quality\nsharp focus"


def test_directive_lines_are_recognised():
    prompt = "#if TXT2IMG\na\n#elseif HIRES_FIX\nb\n#else\nc\n#endif"
    assert prompt_parser.condition_blocks(prompt) == [0, 2, 4, 6]


def test_the_comment_stripper_keeps_the_directives():
    compiled = expand(BRANCH, "hires_fix")
    assert prompt_parser.strip_prompt_comments(compiled) == compiled
    assert prompt_parser.strip_prompt_comments("#if TXT2IMG\n# note\ncat\n#endif") == "#if TXT2IMG\ncat\n#endif"


def test_the_directives_are_dropped_for_the_model():
    assert prompt_parser.strip_condition_directives("#if TXT2IMG\na\n#endif") == "a"
    assert prompt_parser.strip_condition_directives("no blocks, here") == "no blocks, here"
    assert prompt_parser.strip_condition_directives("a\n#if TXT2IMG\n#endif\nb") == "a\nb"
    assert prompt_parser.without_condition_directives(["#if TXT2IMG\na\n#endif", None, 3]) == ["a", None, 3]


def test_compile_prompt_is_what_the_model_gets():
    assert prompt_parser.compile_prompt("#if TXT2IMG\n# note\na\n#endif", prompt_parser.stage_macros("txt2img")) == "a"
    assert prompt_parser.compile_prompt("#if TXT2IMG\na\n#else\nb\n#endif", prompt_parser.stage_macros("img2img")) == "b"
    assert prompt_parser.compile_prompt("cat, #(off), dog", prompt_parser.stage_macros("txt2img")) == "cat, dog"


def test_a_prompt_list_is_resolved_per_stage():
    prompts = ["#if TXT2IMG\nfirst pass\n#else\nhighres\n#endif", "plain"]
    assert prompt_parser.apply_prompt_conditions(prompts, prompt_parser.stage_macros("txt2img")) == [
        "#if TXT2IMG\nfirst pass\n#else\n#endif",
        "plain",
    ]
    assert prompt_parser.apply_prompt_conditions(prompts, prompt_parser.stage_macros("hires_fix")) == [
        "#if TXT2IMG\n#else\nhighres\n#endif",
        "plain",
    ]
    assert prompt_parser.apply_prompt_conditions([None, 3], prompt_parser.stage_macros("txt2img")) == [None, 3]
    assert prompt_parser.apply_prompt_conditions([], prompt_parser.stage_macros("txt2img")) == []
