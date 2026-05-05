"""Test Qwen2.5-Coder GGUF model inference with GPU."""
import time
from pathlib import Path
from models import load_model, generate_response, get_model_info

print("=" * 70)
print("Qwen2.5-Coder Model Inference Test (GPU)")
print("=" * 70)
print()

# Check if model exists
models_dir = Path(__file__).parent / "models"
gguf_files = list(models_dir.glob("*.gguf"))

if not gguf_files:
    print("✗ No GGUF model found in models/ directory")
    print(f"  Expected location: {models_dir}/")
    print()
    print("Download a model first using: download_model.py")
    exit(1)

model_file = gguf_files[0]
print(f"✓ Found model: {model_file.name}")
print(f"  Size: {model_file.stat().st_size / (1024**3):.2f} GB")
print()

# Load model
print("Loading model... (this may take 30-60 seconds)")
print()

start_time = time.time()
try:
    load_model(model_file.stem)
    load_time = time.time() - start_time
    print(f"✓ Model loaded in {load_time:.2f}s")
    print()
except Exception as e:
    print(f"✗ Failed to load model: {e}")
    import traceback
    traceback.print_exc()
    exit(1)

# Get model info
info = get_model_info()
print(f"Model Info:")
print(f"  Status: {info.get('status')}")
print(f"  Context Size: {info.get('context_size')}")
print(f"  Vocabulary Size: {info.get('vocabulary_size')}")
print()

# Test inference
test_prompts = [
    "What is the capital of France?",
    "Explain quantum computing in simple terms.",
    "Write a Python function to calculate fibonacci numbers."
]

print("Running inference tests...")
print()

for i, prompt in enumerate(test_prompts, 1):
    print(f"Test {i}: {prompt}")
    print("Generating response...")
    
    start_time = time.time()
    try:
        response = generate_response(prompt, max_tokens=200)
        gen_time = time.time() - start_time
        
        print(f"Response:\n{response}")
        print(f"Generation time: {gen_time:.2f}s")
        print()
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        print()

print("=" * 70)
print("✓ Inference test complete!")
print("=" * 70)
print()
print("Now you can:")
print("  1. Start the web server: python app.py")
print("  2. Open http://localhost:7820 in your browser")
print("  3. Start chatting!")
