"""Image lineage: op derivation, upstream pins and parent chaining.

The gallery must know how a file was produced and, for derived images, which
asset it came from. The upstream asset is pinned when it is sent to
img2img/inpaint/...; the saved image is bound to that pin by pixel signature
(or by the exact path of a batch input). A parent that is later purged keeps
its reference on the child (the jump button becomes disabled, not hidden).

Plain pytest functions without fixtures: the module can also be executed with a
bare interpreter (see the ``__main__`` block), like test_prompt_picks.py.
"""

import os
import tempfile
from contextlib import contextmanager

from PIL import Image

from modules import endorsement_db, gallery_bridge, gallery_db, gallery_lineage, gallery_sources


@contextmanager
def temp_dbs():
    """Point both gallery databases, the source roots and the pins at a temp dir."""
    old_gallery_path, old_blob_path = gallery_db.DB_PATH, gallery_db.BLOB_DB_PATH
    old_legacy_path = endorsement_db._DB_PATH
    old_endorsed_root = endorsement_db._ENDORSED_ROOT
    old_root = gallery_sources.ROOT
    with tempfile.TemporaryDirectory(prefix="gallery_lineage_test_", ignore_cleanup_errors=True) as root:
        gallery_db.DB_PATH = os.path.join(root, "gallery.db")
        gallery_db.BLOB_DB_PATH = os.path.join(root, "blobs.db")
        gallery_db._ready = False
        endorsement_db._DB_PATH = os.path.join(root, "endorsements.db")
        endorsement_db._ENDORSED_ROOT = os.path.join(root, "endorsed")
        gallery_sources.ROOT = root
        for sub in ("txt2img-images", "img2img-images", "removebg", "composition", "qwen"):
            os.makedirs(os.path.join(root, "outputs", sub), exist_ok=True)
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
            gallery_sources.ROOT = old_root


def make_image(path, seed=0, size=(64, 64)):
    """A gradient image: flat colours all share a dHash and would match wrongly."""
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(size[1]):
        for x in range(size[0]):
            pixels[x, y] = (
                (x * 3 + seed * 53) % 256,
                (y * 2 + seed * 29) % 256,
                ((x + y) * 2 + seed * 71) % 256,
            )
    image.save(path)
    return path


def index(path, infotext="", prompt="a cat", lineage=None):
    endorsement_db.index_image(
        path=path,
        file_mtime=1.0,
        prompt=prompt,
        negative_prompt="",
        seed="1234",
        steps=20,
        sampler="Euler",
        cfg_scale=7.0,
        width=64,
        height=64,
        model_name="test",
        model_hash="abc",
        infotext=infotext,
        lineage=lineage,
    )


def v2_row(path):
    with gallery_db.get_conn() as conn:
        return conn.execute(
            "SELECT * FROM items WHERE path=? COLLATE NOCASE", (path,)
        ).fetchone()


class FakeImg2Img:
    def __init__(self, image=None, mask=None):
        self.init_images = [image] if image is not None else []
        if mask is not None:
            self.image_mask = mask


class FakeTxt2Img:
    def __init__(self, enable_hr=False):
        self.enable_hr = enable_hr


# --------------------------------------------------------------------------- op

def test_op_from_infotext():
    assert gallery_lineage.op_from_infotext("txt2img", "a cat\nSteps: 20") == "txt2img"
    assert gallery_lineage.op_from_infotext(
        "txt2img", "a cat\nSteps: 20, Hires upscale: 2, Hires upscaler: Latent"
    ) == "hires-fix"
    assert gallery_lineage.op_from_infotext(
        "img2img", "a cat\nSteps: 20, Mask blur: 4"
    ) == "inpaint"
    assert gallery_lineage.op_from_infotext(
        "img2img", "a cat\nSteps: 20, Pose inpaint: face"
    ) == "pose-inpaint"
    assert gallery_lineage.op_from_infotext("img2img", "a cat\nSteps: 20") == "img2img"
    assert gallery_lineage.op_from_infotext("composition", "") == "compose"
    assert gallery_lineage.op_from_infotext("qwen", "") == "qwen"
    # an endorsed copy carries the original's infotext
    assert gallery_lineage.op_from_infotext("endorsed", "a cat\nSteps: 20") == "txt2img"
    assert gallery_lineage.op_from_infotext(
        "endorsed", "a cat\nSteps: 20, Denoising strength: 0.4"
    ) == "img2img"
    assert gallery_lineage.op_from_infotext(
        "endorsed", "a cat\nSteps: 20, Hires upscale: 2"
    ) == "hires-fix"
    # a storage bucket is not a generation step
    assert gallery_lineage.op_from_infotext("endorsed", "") == ""
    assert gallery_lineage.display_op({"source": "endorsed", "infotext": ""}) == ""
    assert gallery_lineage.display_op({"source": "endorsed", "infotext": "a cat\nSteps: 20"}) == "txt2img"
    assert gallery_lineage.display_op({"op": "inpaint"}) == "inpaint"


def test_op_for_p():
    assert gallery_lineage.op_for_p(FakeImg2Img()) == "img2img"
    assert gallery_lineage.op_for_p(FakeImg2Img(mask=object())) == "inpaint"
    assert gallery_lineage.op_for_p(FakeTxt2Img()) == "txt2img"
    assert gallery_lineage.op_for_p(FakeTxt2Img(enable_hr=True)) == "hires-fix"
    assert gallery_lineage.op_for_p(None) is None


def test_index_records_op_from_infotext():
    with temp_dbs() as root:
        path = make_image(os.path.join(root, "outputs", "txt2img-images", "00001-hires.png"))
        index(path, infotext="a cat\nSteps: 20, Hires upscale: 2")
        assert v2_row(path)["op"] == "hires-fix"


# ------------------------------------------------------------------------- pins

def test_pin_binds_exact_copy():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        pin = gallery_lineage.pin_item(path=parent, origin="test")
        assert pin and pin["uid"]

        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        assert job.lineage_parent_uid == pin["uid"]
        assert job.lineage_match["kind"] == "pin"

        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        lineage = gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20")
        assert lineage["op"] == "img2img"
        assert lineage["parent_uid"] == pin["uid"]
        index(child, infotext="a dog\nSteps: 20", prompt="a dog", lineage=lineage)

        row = v2_row(child)
        assert row["op"] == "img2img"
        assert row["parent_uid"] == pin["uid"]
        assert row["parent_op"] == "txt2img"
        assert int(row["parent_id"]) == int(v2_row(parent)["id"])


def test_pin_binds_resized_and_reencoded_copy():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        pin = gallery_lineage.pin_item(path=parent, origin="test")

        resized = Image.open(parent).resize((48, 48), Image.LANCZOS)
        job = FakeImg2Img(resized)
        gallery_lineage.attach(job)
        assert job.lineage_parent_uid == pin["uid"]
        assert job.lineage_match["kind"] == "pin"


def test_other_image_does_not_match():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        gallery_lineage.pin_item(path=parent, origin="test")

        other = make_image(os.path.join(root, "outputs", "txt2img-images", "other.png"), seed=5)
        job = FakeImg2Img(Image.open(other))
        gallery_lineage.attach(job)
        assert not getattr(job, "lineage_parent_uid", None)


def test_chain_keeps_the_original_parent():
    """Batch-mask inpaint feeds each result back in; the parent must stay put."""
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        pin = gallery_lineage.pin_item(path=parent, origin="test")

        job = FakeImg2Img(Image.open(parent), mask=object())
        gallery_lineage.attach(job)
        first = job.lineage_parent_uid
        assert first == pin["uid"]

        job.init_images = [Image.new("RGB", (64, 64), (1, 2, 3))]
        gallery_lineage.attach(job)
        assert job.lineage_parent_uid == first


def test_expired_pins_are_ignored():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        gallery_lineage.pin_item(path=parent, origin="test")
        with gallery_db.get_conn() as conn:
            conn.execute("UPDATE lineage_pins SET pinned_at=0")
            conn.commit()
        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        assert not getattr(job, "lineage_parent_uid", None)


# ------------------------------------------------------------------- purging

def test_purged_parent_keeps_the_reference_but_is_disabled():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        parent_id = int(v2_row(parent)["id"])
        pin = gallery_lineage.pin_item(path=parent, origin="test")

        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        index(child, lineage=gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20"))

        gallery_db.delete_item(parent_id)

        row = dict(v2_row(child))
        assert row["parent_uid"] == pin["uid"]  # durable reference survives
        assert row["parent_id"] is None          # the int FK does not dangle

        parent_info = gallery_lineage.resolve_parent(row)
        assert parent_info["uid"] == pin["uid"]
        assert parent_info["exists"] is False
        assert parent_info["reason"] == "deleted"


def test_trashed_parent_is_not_jumpable():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        parent_row = v2_row(parent)
        pin = gallery_lineage.pin_item(path=parent, origin="test")
        parent_image = Image.open(parent).copy()  # trashing may drop the media
        gallery_db.set_state(int(parent_row["id"]), "trashed")

        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        job = FakeImg2Img(parent_image)
        gallery_lineage.attach(job)
        index(child, lineage=gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20"))

        info = gallery_lineage.resolve_parent(dict(v2_row(child)))
        assert info["uid"] == pin["uid"]
        assert info["exists"] is False
        assert info["reason"] == "trashed"


# --------------------------------------------------------------- persistence

def test_reindex_keeps_the_recorded_parent():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        index(child, lineage=gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20"))
        before = dict(v2_row(child))

        index(child, infotext="a dog\nSteps: 20", prompt="a dog")  # plain re-index
        after = dict(v2_row(child))
        assert after["parent_uid"] == before["parent_uid"]
        assert after["parent_op"] == before["parent_op"]
        assert after["op"] == "img2img"


def test_self_parent_is_ignored():
    with temp_dbs() as root:
        path = make_image(os.path.join(root, "outputs", "img2img-images", "self.png"))
        uid = gallery_db.make_uid("img2img", "outputs/img2img-images/self.png")
        gallery_db.upsert_item(uid=uid, source="img2img", path=path,
                               rel_path="outputs/img2img-images/self.png",
                               parent_uid=uid, parent_op="img2img")
        row = v2_row(path)
        assert not row["parent_uid"]
        assert row["parent_id"] is None


def test_removebg_links_parent():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "abc.png"))
        index(parent)
        cut = make_image(os.path.join(root, "outputs", "removebg", "abc-removebg.png"), seed=3)
        gallery_sources.index_item(cut, "removebg", "none")

        row = v2_row(cut)
        assert row["op"] == "removebg"
        assert row["parent_uid"] == v2_row(parent)["uid"]
        assert row["parent_op"] == "txt2img"
        assert row["variant"] == "removebg"


def test_composition_links_base_layer():
    with temp_dbs() as root:
        import json

        base = make_image(os.path.join(root, "outputs", "txt2img-images", "base.png"))
        index(base)
        composed = make_image(os.path.join(root, "outputs", "composition", "composition-1.png"), seed=2)
        with open(os.path.join(root, "outputs", "composition", "composition-1.composerstate.json"), "w") as handle:
            json.dump({"width": 64, "height": 64, "layers": [
                {"name": "top.png", "path": "", "is_background": False},
                {"name": "base.png", "path": base, "is_background": True},
            ]}, handle)
        gallery_sources.index_item(composed, "composition", "sidecar_json")

        row = v2_row(composed)
        assert row["op"] == "compose"
        assert row["parent_uid"] == v2_row(base)["uid"]

        # the SD Lite Composed view keys rows by bare file name
        items = [{"key": "composition-1.png", "path": composed}]
        gallery_lineage.decorate_items(items)
        assert items[0]["op"] == "compose"
        assert items[0]["parent_uid"] == v2_row(base)["uid"]
        assert items[0]["parent_label"] == "txt2img"
        assert items[0]["parent_exists"] is True


# ------------------------------------------------------------------ backfill

def test_backfill_derives_op_and_removebg_parent():
    with temp_dbs() as root:
        hires = make_image(os.path.join(root, "outputs", "txt2img-images", "legacy.png"))
        gallery_db.upsert_item(
            uid=gallery_db.make_uid("txt2img", "outputs/txt2img-images/legacy.png"),
            source="txt2img", path=hires, rel_path="outputs/txt2img-images/legacy.png",
            infotext="a cat\nSteps: 20, Hires upscale: 2",
        )
        stats = gallery_lineage.backfill()
        assert stats["ops"] >= 1
        assert v2_row(hires)["op"] == "hires-fix"


# -------------------------------------------------------------------- mobile

def test_decorate_items_fills_op_and_parent():
    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        pin = gallery_lineage.pin_item(path=parent, origin="test")
        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        index(child, lineage=gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20"))

        child_key = endorsement_db._item_key_from_path(child)
        rows = [{"key": child_key, "path": child}]
        gallery_lineage.decorate_items(rows)
        assert rows[0]["op"] == "img2img"
        assert rows[0]["op_label"] == "img2img"
        assert rows[0]["parent_uid"] == pin["uid"]
        assert rows[0]["parent_label"] == "txt2img"
        assert rows[0]["parent_exists"] is True


def test_decorate_items_falls_back_to_path():
    with temp_dbs() as root:
        path = make_image(os.path.join(root, "outputs", "qwen", "q.png"))
        rows = [{"key": "", "path": path}]
        gallery_lineage.decorate_items(rows)
        assert rows[0]["op"] == "qwen"


# -------------------------------------------------------------------- filters

def test_query_filters_follow_the_chain():
    from modules import gallery_query

    with temp_dbs() as root:
        parent = make_image(os.path.join(root, "outputs", "txt2img-images", "parent.png"))
        index(parent)
        parent_uid = v2_row(parent)["uid"]
        gallery_lineage.pin_item(path=parent, origin="test")

        child = os.path.join(root, "outputs", "img2img-images", "child.png")
        job = FakeImg2Img(Image.open(parent))
        gallery_lineage.attach(job)
        index(child, lineage=gallery_lineage.describe(job, child, infotext="a dog\nSteps: 20"))
        child_uid = v2_row(child)["uid"]

        def uids(filters):
            page = gallery_query.query(filters, "time_desc", 50, 0, with_tags=False)
            return {row["uid"] for row in page["rows"]}

        assert uids({"has_parent": True}) == {child_uid}
        assert uids({"has_parent": False}) == {parent_uid}
        assert uids({"ops": ["img2img"]}) == {child_uid}
        assert uids({"ancestor": parent_uid}) == {parent_uid, child_uid}
        assert uids({"ancestor": child_uid}) == {child_uid}


if __name__ == "__main__":
    failures = 0
    for name, case in sorted(globals().items()):
        if not name.startswith("test_") or not callable(case):
            continue
        try:
            case()
            print(f"PASS {name}")
        except Exception as exc:  # noqa: BLE001 - standalone runner
            failures += 1
            print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
