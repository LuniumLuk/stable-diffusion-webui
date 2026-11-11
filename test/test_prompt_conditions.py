from modules import prompt_parser

STAGES = ("txt2img", "hires_fix", "img2img", "inpaint", "pose_inpaint")


def expand(prompt, stage=None, **kwargs):
    return prompt_parser.expand_prompt_conditions(prompt, prompt_parser.stage_macros(stage, **kwargs))


def content(prompt, stage=None, **kwargs):
    """The text the model sees: the resolved prompt without its directive lines."""
    return prompt_parser.strip_condition_directives(expand(prompt, stage, **kwargs))


BRANCH = "@IF TXT2IMG\ntxt2img text\n@ELSEIF HIRES_FIX\nhires text\n@ELSE\nimg2img text\n@ENDIF"


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
    assert expand(BRANCH, "txt2img") == "@IF TXT2IMG\ntxt2img text\n@ELSEIF HIRES_FIX\n@ELSE\n@ENDIF"
    assert expand(BRANCH, "hires_fix") == "@IF TXT2IMG\n@ELSEIF HIRES_FIX\nhires text\n@ELSE\n@ENDIF"
    assert expand(BRANCH, "img2img") == "@IF TXT2IMG\n@ELSEIF HIRES_FIX\n@ELSE\nimg2img text\n@ENDIF"
    for stage in STAGES:
        resolved = expand(BRANCH, stage)
        assert "@IF TXT2IMG" in resolved
        assert "@ELSEIF HIRES_FIX" in resolved
        assert "@ELSE" in resolved
        assert resolved.endswith("@ENDIF")
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


def test_elif_is_accepted_as_an_alias_for_elseif():
    prompt = "@IF TXT2IMG\na\n@ELIF HIRES_FIX\nb\n@ELSE\nc\n@ENDIF"
    assert content(prompt, "hires_fix") == "b"
    assert content(prompt, "img2img") == "c"


def test_the_else_branch_is_only_taken_when_no_condition_matched():
    prompt = "@IF INPAINT\ninpaint\n@ELSE\nother\n@ENDIF"
    assert content(prompt, "inpaint") == "inpaint"
    assert content(prompt, "txt2img") == "other"
    assert expand(prompt, "inpaint") == "@IF INPAINT\ninpaint\n@ELSE\n@ENDIF"
    assert expand(prompt, "txt2img") == "@IF INPAINT\n@ELSE\nother\n@ENDIF"


def test_blocks_may_be_nested():
    prompt = "@IF TXT2IMG\na\n@IF IMG2IMG\nb\n@ELSE\nc\n@ENDIF\nd\n@ENDIF"
    assert content(prompt, "txt2img") == "a\nc\nd"
    assert content(prompt, "hires_fix") == ""
    assert content(prompt, "img2img") == ""
    # the outer block keeps its skeleton, the inner one lived in a dropped branch
    assert expand(prompt, "hires_fix") == "@IF TXT2IMG\n@ENDIF"
    assert expand(prompt, "txt2img") == "@IF TXT2IMG\na\n@IF IMG2IMG\n@ELSE\nc\n@ENDIF\nd\n@ENDIF"


def test_a_block_inside_a_dropped_branch_loses_its_directives():
    prompt = "@IF TXT2IMG\na\n@IF IMG2IMG\nb\n@ENDIF\n@ENDIF\ncat"
    assert expand(prompt, "img2img") == "@IF TXT2IMG\n@ENDIF\ncat"
    assert expand(prompt, "txt2img") == "@IF TXT2IMG\na\n@IF IMG2IMG\n@ENDIF\n@ENDIF\ncat"


def test_negation_and_boolean_operators():
    assert content("@IF !TXT2IMG\nx\n@ENDIF", "txt2img") == ""
    assert content("@IF TXT2IMG && !INPAINT\nx\n@ENDIF", "txt2img") == "x"
    assert content("@IF INPAINT || POSE_INPAINT\nx\n@ENDIF", "inpaint") == "x"
    assert content("@IF (TXT2IMG or IMG2IMG) and !HIRES_FIX\nx\n@ENDIF", "img2img") == "x"
    assert content("@IF (TXT2IMG or IMG2IMG) and !HIRES_FIX\nx\n@ENDIF", "hires_fix") == ""


def test_pose_part_enum():
    hands = "@IF POSE_INPAINT_PART == HANDS\nhands\n@ENDIF"
    assert content(hands, "pose_inpaint", pose_part="left_hand") == "hands"
    assert content(hands, "pose_inpaint", pose_part="FACE") == ""
    assert content(hands, "txt2img") == ""

    face = "@IF POSE_INPAINT_PART == FACE\nface\n@ELSE\nother\n@ENDIF"
    assert content(face, "pose_inpaint", pose_part="face") == "face"
    assert content(face, "pose_inpaint", pose_part="right_foot") == "other"
    assert content(face, "txt2img") == "other"

    assert content("@IF POSE_INPAINT_PART != FEET\nx\n@ENDIF", "pose_inpaint", pose_part="HANDS") == "x"
    assert content("@IF POSE_INPAINT_PART == 0\nnone\n@ENDIF", "txt2img") == "none"
    assert content("@IF POSE_INPAINT_PART == NONE\nnone\n@ENDIF", "txt2img") == "none"

    body = "@IF POSE_INPAINT_PART == BODY\nbody\n@ELSE\nother\n@ENDIF"
    assert content(body, "pose_inpaint", pose_part="knees") == "body"
    assert content(body, "pose_inpaint", pose_part="BODY") == "body"
    assert content(body, "pose_inpaint", pose_part="face") == "other"


def test_pose_inpaint_part_mapping():
    assert prompt_parser.pose_inpaint_part(None) == 0
    assert prompt_parser.pose_inpaint_part("Face") == "FACE"
    assert prompt_parser.pose_inpaint_part("hands") == "HANDS"
    assert prompt_parser.pose_inpaint_part("left_foot") == "FEET"
    assert prompt_parser.pose_inpaint_part("Shoulders") == "BODY"
    assert prompt_parser.pose_inpaint_part("knees") == "BODY"
    assert prompt_parser.pose_inpaint_part("Custom nodes") == "BODY"
    assert prompt_parser.pose_inpaint_part("all") == 0
    assert prompt_parser.pose_inpaint_part("nonsense") == 0


def test_an_unknown_macro_counts_as_false():
    assert content("@IF NOPE\na\n@ELSE\nb\n@ENDIF", "txt2img") == "b"


def test_a_broken_expression_counts_as_false():
    for condition in ("TXT2IMG ==", "(TXT2IMG", "TXT2IMG &"):
        assert content(f"@IF {condition}\na\n@ELSE\nb\n@ENDIF", "txt2img") == "b"


def test_a_block_that_is_not_closed_stays_as_typed():
    assert expand("@IF TXT2IMG\na", "txt2img") == "@IF TXT2IMG\na"
    assert expand("@IF TXT2IMG\n@IF IMG2IMG\na\n@ENDIF", "txt2img") == "@IF TXT2IMG\n@IF IMG2IMG\na\n@ENDIF"


def test_stray_directives_stay_as_typed():
    assert expand("@ELSE\na", "txt2img") == "@ELSE\na"
    assert expand("@ENDIF\na", "txt2img") == "@ENDIF\na"
    assert expand("@IF TXT2IMG\n@ELSE\na\n@ELSE\nb\n@ENDIF", "txt2img") == "@IF TXT2IMG\n@ELSE\na\n@ELSE\nb\n@ENDIF"


def test_directives_need_a_line_of_their_own():
    prompt = "a, @IF TXT2IMG x @ENDIF b"
    assert expand(prompt, "txt2img") == prompt
    assert expand("#iffy TXT2IMG\na\n@ENDIF", "txt2img") == "#iffy TXT2IMG\na\n@ENDIF"


def test_comments_and_text_of_the_other_branches():
    prompt = "@IF TXT2IMG\nbest quality, # a note\n@ELSE\nlow quality\n@ENDIF\nsharp focus"
    assert expand(prompt, "txt2img") == "@IF TXT2IMG\nbest quality, # a note\n@ELSE\n@ENDIF\nsharp focus"
    assert content(prompt, "hires_fix") == "low quality\nsharp focus"


def test_directive_lines_are_recognised():
    prompt = "@IF TXT2IMG\na\n@ELSEIF HIRES_FIX\nb\n@ELSE\nc\n@ENDIF"
    assert prompt_parser.condition_blocks(prompt) == [0, 2, 4, 6]


def test_the_comment_stripper_keeps_the_directives():
    compiled = expand(BRANCH, "hires_fix")
    assert prompt_parser.strip_prompt_comments(compiled) == compiled
    assert prompt_parser.strip_prompt_comments("@IF TXT2IMG\n# note\ncat\n@ENDIF") == "@IF TXT2IMG\ncat\n@ENDIF"


def test_the_directives_are_dropped_for_the_model():
    assert prompt_parser.strip_condition_directives("@IF TXT2IMG\na\n@ENDIF") == "a"
    assert prompt_parser.strip_condition_directives("no blocks, here") == "no blocks, here"
    assert prompt_parser.strip_condition_directives("a\n@IF TXT2IMG\n@ENDIF\nb") == "a\nb"
    assert prompt_parser.without_condition_directives(["@IF TXT2IMG\na\n@ENDIF", None, 3]) == ["a", None, 3]


def test_compile_prompt_is_what_the_model_gets():
    assert prompt_parser.compile_prompt("@IF TXT2IMG\n# note\na\n@ENDIF", prompt_parser.stage_macros("txt2img")) == "a"
    assert prompt_parser.compile_prompt("@IF TXT2IMG\na\n@ELSE\nb\n@ENDIF", prompt_parser.stage_macros("img2img")) == "b"
    assert prompt_parser.compile_prompt("cat, #(off), dog", prompt_parser.stage_macros("txt2img")) == "cat, dog"


def test_custom_macro_definitions_parse_bool_and_enum():
    definitions = prompt_parser.parse_macro_definitions(
        "@MACRO(FLAG)\n@MACRO(mood){happy, sad}\n@MACRO()\n@MACRO(EMPTY){}"
    )
    assert definitions["FLAG"]["type"] == "bool"
    assert definitions["FLAG"]["default"] == 0
    assert definitions["MOOD"]["type"] == "enum"
    assert definitions["MOOD"]["values"] == ["happy", "sad"]
    assert definitions["MOOD"]["default"] == "happy"
    assert "EMPTY" not in definitions


def test_custom_macro_values_use_the_definition_defaults_and_ui_state():
    prompt = "@MACRO(FLAG)\n@MACRO(MOOD){happy, sad}"
    assert prompt_parser.custom_macro_values(prompt) == {"FLAG": 0, "MOOD": "happy"}
    assert prompt_parser.custom_macro_values(prompt, {"flag": True, "mood": "sad"}) == {"FLAG": 1, "MOOD": "sad"}
    assert prompt_parser.custom_macro_values(prompt, {"MOOD": "angry"})["MOOD"] == "happy"


def test_custom_macros_resolve_their_branches():
    prompt = (
        "@MACRO(FLAG)\n@MACRO(MOOD){happy, sad}\n"
        "@IF FLAG\nflag on\n@ELSE\nflag off\n@ENDIF\n"
        "@IF MOOD == sad\nsad\n@ELIF MOOD == happy\nhappy\n@ENDIF"
    )
    macros = prompt_parser.macros_for_prompts("txt2img", [prompt], {"FLAG": 1, "MOOD": "sad"})
    resolved = prompt_parser.strip_condition_directives(prompt_parser.expand_prompt_conditions(prompt, macros))
    assert "flag on" in resolved and "flag off" not in resolved
    assert "sad" in resolved and "happy" not in resolved

    defaults = prompt_parser.macros_for_prompts("txt2img", [prompt])
    resolved = prompt_parser.strip_condition_directives(prompt_parser.expand_prompt_conditions(prompt, defaults))
    assert "flag off" in resolved and "flag on" not in resolved
    assert "happy" in resolved and "sad" not in resolved


def test_undefined_custom_macros_behave_as_off_booleans():
    assert content("@IF NOPE\nx\n@ELSE\ny\n@ENDIF", "txt2img") == "y"
    assert content("@IF !NOPE\nx\n@ENDIF", "txt2img") == "x"
    assert content("@IF NOPE == 1\nx\n@ELSE\ny\n@ENDIF", "txt2img") == "y"

    prompt = "@IF NOPE\nx\n@ELSE\ny\n@ENDIF"
    assert prompt_parser.custom_macro_values("", {"NOPE": True}) == {"NOPE": 1}
    macros = prompt_parser.macros_for_prompts("txt2img", [prompt], {"NOPE": 1})
    assert prompt_parser.expand_prompt_conditions(prompt, macros) == "@IF NOPE\nx\n@ELSE\n@ENDIF"


def test_macro_definitions_are_stripped_from_the_model_prompt():
    prompt = "@MACRO(FLAG)\n@MACRO(MOOD){happy, sad}\n@IF FLAG\nyes\n@ENDIF\ncat"
    assert prompt_parser.strip_condition_directives(prompt) == "yes\ncat"
    assert prompt_parser.strip_condition_directives("@MACRO()\ncat") == "cat"
    assert prompt_parser.compile_prompt(prompt, prompt_parser.macros_for_prompts("txt2img", [prompt], {"FLAG": 1})) == "yes\ncat"


def test_legacy_hash_directives_are_upgraded_when_a_prompt_is_imported():
    from modules.prompt_syntax import upgrade_legacy_directives

    assert upgrade_legacy_directives("#if TXT2IMG\na\n#elseif HIRES_FIX\nb\n#else\nc\n#endif") == (
        "@IF TXT2IMG\na\n@ELSEIF HIRES_FIX\nb\n@ELSE\nc\n@ENDIF"
    )
    assert upgrade_legacy_directives("  #elif IMG2IMG") == "  @ELIF IMG2IMG"
    assert upgrade_legacy_directives("# a comment") == "# a comment"
    assert upgrade_legacy_directives("# #if TXT2IMG") == "# #if TXT2IMG"
    assert upgrade_legacy_directives("#iffy TXT2IMG") == "#iffy TXT2IMG"
    assert upgrade_legacy_directives(None) is None


def test_a_prompt_list_is_resolved_per_stage():
    prompts = ["@IF TXT2IMG\nfirst pass\n@ELSE\nhighres\n@ENDIF", "plain"]
    assert prompt_parser.apply_prompt_conditions(prompts, prompt_parser.stage_macros("txt2img")) == [
        "@IF TXT2IMG\nfirst pass\n@ELSE\n@ENDIF",
        "plain",
    ]
    assert prompt_parser.apply_prompt_conditions(prompts, prompt_parser.stage_macros("hires_fix")) == [
        "@IF TXT2IMG\n@ELSE\nhighres\n@ENDIF",
        "plain",
    ]
    assert prompt_parser.apply_prompt_conditions([None, 3], prompt_parser.stage_macros("txt2img")) == [None, 3]
    assert prompt_parser.apply_prompt_conditions([], prompt_parser.stage_macros("txt2img")) == []
