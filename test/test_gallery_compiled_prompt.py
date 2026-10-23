"""Compiled-prompt persistence in the gallery databases.

Every generated image keeps two prompts: the source (as typed, comments and
@PICK groups intact, written to the PNG infotext) and the compiled prompt that
was actually sent to the model. ``index_image`` stores both in the legacy
``generated_images`` table and mirrors them into gallery.db ``items``; passing
``compiled_prompt=None`` (a re-index of an old file) must never wipe a value.

Plain pytest functions without fixtures: the module can also be executed with a
bare interpreter (see the ``__main__`` block), like test_prompt_picks.py.
"""

import os
import tempfile
from contextlib import contextmanager

from modules import endorsement_db, gallery_bridge, gallery_db


@contextmanager
def temp_dbs():
    """Point both gallery databases at a throwaway directory."""
    old_gallery_path, old_blob_path = gallery_db.DB_PATH, gallery_db.BLOB_DB_PATH
    old_legacy_path = endorsement_db._DB_PATH
    old_endorsed_root = endorsement_db._ENDORSED_ROOT
    with tempfile.TemporaryDirectory(prefix="gallery_prompt_test_", ignore_cleanup_errors=True) as root:
        gallery_db.DB_PATH = os.path.join(root, "gallery.db")
        gallery_db.BLOB_DB_PATH = os.path.join(root, "blobs.db")
        gallery_db._ready = False
        endorsement_db._DB_PATH = os.path.join(root, "endorsements.db")
        endorsement_db._ENDORSED_ROOT = os.path.join(root, "endorsed")
        previous_bridge = gallery_bridge.v2_enabled()
        gallery_bridge.set_enabled(True)
        gallery_db.init_db()
        endorsement_db.init_db()
        try:
            yield root
        finally:
            gallery_bridge.set_enabled(previous_bridge)
            gallery_db.DB_PATH, gallery_db.BLOB_DB_PATH = old_gallery_path, old_blob_path
            gallery_db._ready = False
            endorsement_db._DB_PATH = old_legacy_path
            endorsement_db._ENDORSED_ROOT = old_endorsed_root


def write_png(path):
    """Endorse/dislike move the file, so the path has to exist."""
    from PIL import Image

    Image.new("RGB", (8, 8), (12, 15, 25)).save(path)
    return path


SOURCE_PROMPT = "photo of a @PICK{cat, dog}, #(junk) red car"


def index(path, compiled="compiled cat, red car", negative="", source=SOURCE_PROMPT):
    endorsement_db.index_image(
        path=path,
        file_mtime=1.0,
        prompt=source,
        negative_prompt="lowres",
        seed="1234",
        steps=20,
        sampler="Euler",
        cfg_scale=7.0,
        width=512,
        height=512,
        model_name="test",
        model_hash="abc",
        infotext="parameters",
        compiled_prompt=compiled,
        compiled_negative_prompt=negative,
    )


def legacy_row(path):
    with endorsement_db._get_conn() as conn:
        return conn.execute(
            "SELECT prompt, compiled_prompt, compiled_negative_prompt FROM generated_images WHERE path=?",
            (path,),
        ).fetchone()


def v2_row(path):
    with gallery_db.get_conn() as conn:
        return conn.execute(
            "SELECT prompt, compiled_prompt, compiled_negative_prompt FROM items WHERE path=?",
            (path,),
        ).fetchone()


def test_index_image_stores_source_and_compiled_prompt():
    with temp_dbs() as root:
        path = os.path.join(root, "00001-1234.png")
        index(path)

        row = legacy_row(path)
        assert row["prompt"] == SOURCE_PROMPT
        assert row["compiled_prompt"] == "compiled cat, red car"

        stored = v2_row(path)
        assert stored is not None, "the save must also be mirrored into gallery.db"
        assert stored["prompt"] == SOURCE_PROMPT
        assert stored["compiled_prompt"] == "compiled cat, red car"


def test_reindex_without_a_compiled_prompt_keeps_the_stored_one():
    with temp_dbs() as root:
        path = os.path.join(root, "00002-1234.png")
        index(path)
        index(path, compiled=None, negative=None)

        assert legacy_row(path)["compiled_prompt"] == "compiled cat, red car"
        assert v2_row(path)["compiled_prompt"] == "compiled cat, red car"


def test_a_different_image_reusing_the_path_drops_the_old_compiled_prompt():
    """A1111 recycles filename sequence numbers, so the path can belong to a new picture."""
    with temp_dbs() as root:
        path = os.path.join(root, "00003-1234.png")
        index(path)
        index(path, compiled=None, negative=None, source="a different photo")

        row = legacy_row(path)
        assert row["prompt"] == "a different photo"
        assert row["compiled_prompt"] == ""


def test_an_explicit_empty_compiled_prompt_is_stored():
    with temp_dbs() as root:
        path = os.path.join(root, "00009-1234.png")
        index(path)
        index(path, compiled="", negative="")

        assert legacy_row(path)["compiled_prompt"] == ""
        assert v2_row(path)["compiled_prompt"] == ""


def test_rows_without_a_compiled_prompt_stay_empty():
    with temp_dbs() as root:
        path = os.path.join(root, "00004-1234.png")
        index(path, compiled="", negative="")

        assert legacy_row(path)["compiled_prompt"] == ""
        assert v2_row(path)["compiled_prompt"] == ""


def test_endorsing_carries_the_compiled_prompt_over():
    with temp_dbs() as root:
        path = write_png(os.path.join(root, "00005-1234.png"))
        index(path)
        endorsement_db.endorse(
            path, "source prompt", "lowres", "1234", 20, "Euler", 7.0, 512, 512,
            "test", "abc", "parameters",
        )

        with endorsement_db._get_conn() as conn:
            row = conn.execute(
                "SELECT compiled_prompt, compiled_negative_prompt FROM endorsements WHERE item_key=?",
                (endorsement_db._item_key_from_path(path),),
            ).fetchone()
        assert row is not None
        assert row["compiled_prompt"] == "compiled cat, red car"


def test_disliking_carries_the_compiled_prompt_over():
    with temp_dbs() as root:
        path = write_png(os.path.join(root, "00006-1234.png"))
        index(path)
        endorsement_db.dislike(
            path, "source prompt", "lowres", "1234", 20, "Euler", 7.0, 512, 512,
            "test", "abc", "parameters",
        )

        with endorsement_db._get_conn() as conn:
            row = conn.execute(
                "SELECT compiled_prompt FROM dislikes WHERE item_key=?",
                (endorsement_db._item_key_from_path(path),),
            ).fetchone()
        assert row is not None
        assert row["compiled_prompt"] == "compiled cat, red car"


def test_v2_upsert_keeps_the_compiled_prompt_when_only_the_prompt_is_refreshed():
    """A rescan rewrites the source prompt but cannot re-derive the draw."""
    with temp_dbs() as root:
        path = os.path.join(root, "00007-1234.png")
        index(path, compiled="compiled cat, red car")
        item = gallery_db.get_item_by_path(os.path.normpath(path))
        assert item and item["compiled_prompt"] == "compiled cat, red car"

        gallery_db.upsert_item(uid=item["uid"], source=item["source"], prompt=SOURCE_PROMPT)

        refreshed = gallery_db.get_item_by_path(os.path.normpath(path))
        assert refreshed["prompt"] == SOURCE_PROMPT
        assert refreshed["compiled_prompt"] == "compiled cat, red car"


def test_rescan_without_the_legacy_row_keeps_the_gallery_db_value():
    """A rebuilt/cleared endorsements.db must not wipe gallery.db's compiled prompts."""
    with temp_dbs() as root:
        path = os.path.join(root, "00010-1234.png")
        index(path)
        with endorsement_db._get_conn() as conn:
            conn.execute("DELETE FROM generated_images")
            conn.commit()

        index(path, compiled=None, negative=None)

        assert legacy_row(path)["compiled_prompt"] == ""
        assert v2_row(path)["compiled_prompt"] == "compiled cat, red car"


def test_old_images_without_the_columns_stay_readable():
    """Back-compat: rows indexed before the feature simply have no compiled prompt."""
    with temp_dbs() as root:
        path = os.path.join(root, "00008-1234.png")
        index(path, compiled="", negative="")
        stored = v2_row(path)
        assert stored["compiled_prompt"] == ""
        assert stored["compiled_negative_prompt"] == ""


if __name__ == "__main__":
    import sys

    failures = 0
    for _name in sorted(n for n in dir() if n.startswith("test_")):
        try:
            globals()[_name]()
            print("ok  ", _name)
        except Exception as exc:  # noqa: BLE001 - tiny standalone runner
            failures += 1
            print("FAIL", _name, "->", repr(exc))
    print(failures and f"{failures} FAILURE(S)" or "all checks passed")
    sys.exit(1 if failures else 0)
