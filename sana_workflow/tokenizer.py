"""Shared helper: load a SANA-compatible fast tokenizer on the webui venv.

SANA's Gemma `tokenizer.json` is written by `tokenizers>=0.20` (it contains the
new `ignore_merges` BPE field), which the venv's `tokenizers==0.19.1` cannot
parse ("untagged enum ModelWrapper"). The venv pins `tokenizers<0.20` because
`transformers==4.44.2` (kohya/webui) requires it, so instead of upgrading we
rebuild the fast tokenizer from the sentencepiece model using transformers'
official `GemmaConvert`, and re-apply the original post-processor (prepend
`<bos>`, no eos) so token IDs match the model's expectation exactly.
"""
from __future__ import annotations

from transformers import AutoTokenizer, PreTrainedTokenizerFast
from transformers.convert_slow_tokenizer import GemmaConvert
from tokenizers import processors


def load_sana_tokenizer(hf_id: str) -> PreTrainedTokenizerFast:
    """Build a PreTrainedTokenizerFast for a SANA model from its sentencepiece file."""
    slow = AutoTokenizer.from_pretrained(hf_id, subfolder="tokenizer", use_fast=False)
    converted = GemmaConvert(slow).converted()
    # original tokenizer.json post-processor: prepend <bos>, no eos
    converted.post_processor = processors.TemplateProcessing(
        single="<bos>:0 $A:0",
        pair="<bos>:0 $A:0 <bos>:1 $B:1",
        special_tokens=[("<bos>", slow.bos_token_id)],
    )
    return PreTrainedTokenizerFast(
        tokenizer_object=converted,
        bos_token=slow.bos_token,
        eos_token=slow.eos_token,
        unk_token=slow.unk_token,
        pad_token=slow.pad_token,
        model_max_length=slow.model_max_length,
    )
