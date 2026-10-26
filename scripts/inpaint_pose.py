import logging
from typing import Any

import gradio as gr
from fastapi import HTTPException
from pydantic import BaseModel, Field

from modules import inpaint_pose, script_callbacks

logger = logging.getLogger(__name__)


class InpaintPoseRequest(BaseModel):
    input_image: str
    regions: list[str] = Field(default_factory=lambda: ["face", "hands", "feet"])
    radius: int = 40
    backend: str = "auto"
    include_skeleton: bool = True


def inpaint_pose_api(_: gr.Blocks, app):
    @app.get("/inpaint-pose/status")
    def pose_status() -> Any:
        return inpaint_pose.backend_status()

    @app.post("/inpaint-pose/download")
    def pose_download() -> Any:
        try:
            result = inpaint_pose.download_dwpose_models()
        except inpaint_pose.PoseModelUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except Exception as error:
            logger.exception("DWPose model download failed")
            raise HTTPException(status_code=500, detail=f"DWPose download failed: {error}") from error
        result["status"] = inpaint_pose.backend_status()
        return result

    @app.post("/inpaint-pose/detect")
    def pose_detect(payload: InpaintPoseRequest) -> Any:
        try:
            image = inpaint_pose.decode_image_data_url(payload.input_image)
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Invalid input image: {error}") from error

        try:
            return inpaint_pose.detect_inpaint_regions(
                image,
                regions=payload.regions,
                radius=payload.radius,
                backend=payload.backend,
                include_skeleton=payload.include_skeleton,
            )
        except inpaint_pose.PoseModelUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            logger.exception("Inpaint pose detection failed")
            raise HTTPException(status_code=500, detail=f"Pose analysis failed: {error}") from error


script_callbacks.on_app_started(inpaint_pose_api)
