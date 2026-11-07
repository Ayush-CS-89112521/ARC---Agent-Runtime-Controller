#!/usr/bin/env python3
"""
Steering Demo Generator - Alternative Implementation
Generates a high-fidelity static demo image without requiring VHS
Falls back to Python + PIL if VHS is not available
"""

import os
import sys
from pathlib import Path

def generate_steering_demo_image():
    """Generate steering demo as a high-quality PNG image"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("❌ Pillow not installed. Installing...")
        os.system("pip install pillow -q")
        from PIL import Image, ImageDraw, ImageFont
    
    # Create image: 1280x720 (16:9 aspect ratio)
    width, height = 1280, 720
    
    # Dracula theme colors
    bg_color = (40, 42, 54)           # Dark background
    fg_color = (248, 248, 242)        # Light text
    accent_color = (189, 147, 249)    # Purple (Dracula accent)
    success_color = (80, 250, 123)    # Green
    warning_color = (255, 121, 198)   # Red/Pink
    cyan_color = (139, 233, 253)      # Cyan
    
    img = Image.new('RGB', (width, height), bg_color)
    draw = ImageDraw.Draw(img)
    
    # Try to use a monospace font
    try:
        # Try common monospace fonts
        for font_name in ['DejaVuSansMono.ttf', 'Courier New', 'Monospace']:
            try:
                title_font = ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{font_name}", 24)
                text_font = ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{font_name}", 16)
                small_font = ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{font_name}", 14)
                break
            except:
                continue
        else:
            # Fallback to default
            title_font = ImageFont.load_default()
            text_font = ImageFont.load_default()
            small_font = ImageFont.load_default()
    except:
        title_font = ImageFont.load_default()
        text_font = ImageFont.load_default()
        small_font = ImageFont.load_default()
    
    y = 40
    
    # Title
    draw.text((40, y), "🎛️  STEERING INTERFACE DEMO - Phase 5 Human-in-the-Loop", 
              fill=accent_color, font=title_font)
    y += 50
    
    # Separator
    draw.line([(40, y), (1240, y)], fill=accent_color, width=2)
    y += 30
    
    # Scene title
    draw.text((40, y), "SCENARIO: User Corrects Dangerous Git Command", 
              fill=cyan_color, font=text_font)
    y += 40
    
    # Step 1: Initial command
    draw.text((40, y), "1️⃣  User runs:", fill=fg_color, font=text_font)
    y += 30
    draw.text((60, y), "$ arc deploy.yaml --step-mode", fill=success_color, font=text_font)
    y += 35
    
    # Step 2: Dangerous proposal
    draw.text((40, y), "2️⃣  Agent proposes:", fill=warning_color, font=text_font)
    y += 30
    draw.text((60, y), "git push origin main --force", fill=warning_color, font=text_font)
    draw.text((60, y + 25), "⚠️  DANGEROUS - Force push to main!", fill=warning_color, font=small_font)
    y += 60
    
    # Step 3: Steering menu
    draw.text((40, y), "3️⃣  Steering Menu Appears:", fill=cyan_color, font=text_font)
    y += 30
    draw.text((60, y), "  [R]un", fill=fg_color, font=text_font)
    draw.text((200, y), "[E]dit", fill=accent_color, font=text_font)
    draw.text((320, y), "[C]ontext", fill=fg_color, font=text_font)
    draw.text((520, y), "[T]erminate", fill=fg_color, font=text_font)
    y += 35
    draw.text((60, y), "User selects: [E]dit", fill=accent_color, font=text_font)
    y += 40
    
    # Step 4: Correction
    draw.text((40, y), "4️⃣  User Corrects:", fill=success_color, font=text_font)
    y += 30
    draw.text((60, y), "From: git push origin main --force", fill=warning_color, font=small_font)
    y += 25
    draw.text((60, y), "To:   git push origin dev", fill=success_color, font=small_font)
    y += 40
    
    # Step 5: Proof
    draw.text((40, y), "5️⃣  Audit Trail Recorded:", fill=success_color, font=text_font)
    y += 30
    draw.text((60, y), "✅ Context injected into step 'deploy'", fill=success_color, font=small_font)
    y += 25
    draw.text((60, y), "   Type: parameter-adjustment", fill=success_color, font=small_font)
    y += 25
    draw.text((60, y), "🎓 Training data: #git-safety #human-intervention", fill=success_color, font=small_font)
    
    # Footer
    footer_y = height - 40
    draw.line([(40, footer_y - 10), (1240, footer_y - 10)], fill=accent_color, width=1)
    draw.text((40, footer_y), "✨ Human decision changed execution path ✨ Audit trail proves intervention", 
              fill=accent_color, font=small_font)
    
    # Save
    output_path = Path(__file__).parent / "steering-demo.png"
    img.save(str(output_path), 'PNG', quality=95)
    return output_path

def main():
    """Main entry point"""
    print("\n" + "=" * 70)
    print("🎛️  Steering Demo Image Generator (Fallback Implementation)")
    print("=" * 70 + "\n")
    
    print("📋 Checking for VHS installation...")
    vhs_available = os.system("which vhs >/dev/null 2>&1") == 0
    
    if vhs_available:
        print("✅ VHS found - using VHS to generate GIF")
        print("\nGenerating animated GIF from VHS tape...")
        os.system("vhs < steering-demo.tape")
        output = Path("steering-demo.gif")
        if output.exists():
            size_kb = output.stat().st_size / 1024
            print(f"\n✅ GIF generated: {output} ({size_kb:.1f} KB)")
            return 0
    
    print("⚠️  VHS not available - generating static demo image instead")
    print("   (High-quality PNG showing all key scenes)\n")
    
    print("🎨 Generating steering demo image...")
    output = generate_steering_demo_image()
    
    if output.exists():
        size_kb = output.stat().st_size / 1024
        print(f"\n{'=' * 70}")
        print(f"✅ Demo image generated successfully!")
        print(f"{'=' * 70}\n")
        print(f"📊 Output: {output}")
        print(f"📦 Size: {size_kb:.1f} KB")
        print(f"📺 Format: PNG (high-quality, lossless)")
        print(f"📐 Resolution: 1280×720 (16:9 aspect ratio)\n")
        print("📝 Next steps:")
        print("   1. View the image: open steering-demo.png")
        print("   2. Add to README.md: ![Steering Demo](steering-demo.png)")
        print("   3. Commit: git add steering-demo.png")
        print("   4. Push: git push origin main\n")
        return 0
    else:
        print("❌ Failed to generate demo image")
        return 1

if __name__ == "__main__":
    sys.exit(main())
