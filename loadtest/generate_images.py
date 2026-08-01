import os, random, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

random.seed(42)
OUT = "/home/claude/work/loadtest/images"
os.makedirs(OUT, exist_ok=True)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT = ImageFont.truetype(FONT_PATH, 22)

MEDS = ["PARACETAMOL 500MG", "AMOXICILLIN 250MG", "AZITHROMYCIN 500MG", "ATORVASTATIN 10MG",
        "METFORMIN 500MG", "OMEPRAZOLE 20MG", "CETIRIZINE 10MG", "AMLODIPINE 5MG",
        "PANTOPRAZOLE 40MG", "DOLO 650MG", "ROSEDAY 10MG", "SHELCAL 500MG",
        "AUGMENTIN 625MG", "TELMA 40MG", "GLIMEPIRIDE 2MG", "LEVOCETIRIZINE 5MG"]

def gen_bill_text(n_items=15):
    lines = ["TAX INVOICE", "GSTIN: 29ABCDE1234F1Z5", "Distributor: ABC Pharma Distributors",
             f"Invoice No: INV-{random.randint(10000,99999)}", "Date: 15/07/2026", ""]
    lines.append(f"{'Medicine':22}{'Batch':10}{'Exp':8}{'Qty':6}{'MRP':8}{'GST':6}")
    for i in range(n_items):
        med = random.choice(MEDS)
        batch = f"B{random.randint(1000,9999)}"
        exp = f"{random.randint(1,12):02d}/{random.randint(26,29)}"
        qty = random.randint(5, 50)
        mrp = round(random.uniform(20, 300), 2)
        gst = random.choice([5, 12, 18])
        lines.append(f"{med:22}{batch:10}{exp:8}{qty:<6}{mrp:<8}{gst}%")
    lines.append("")
    lines.append(f"Total Items: {n_items}")
    lines.append(f"Invoice Total: Rs. {round(random.uniform(2000,15000),2)}")
    return "\n".join(lines)

def gen_order_text(n_items=12):
    lines = ["DISPENSARY: Kastoori PHC", "ORDER SHEET", f"Order Date: 15/07/2026", "",
              f"{'Medicine':25}{'Required Qty':12}"]
    for i in range(n_items):
        med = random.choice(MEDS)
        qty = random.choice([30, 60, 90, 120, 150, 200, 240])
        lines.append(f"{med:25}{qty}")
    return "\n".join(lines)

def render_text_image(text, degrade_level=0):
    lines = text.split("\n")
    w, h = 900, 40 + 30 * len(lines)
    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    y = 20
    for line in lines:
        draw.text((20, y), line, font=FONT, fill=(20, 20, 20))
        y += 28

    if degrade_level >= 1:
        img = img.rotate(random.uniform(-3, 3), fillcolor="white", expand=True)
    if degrade_level >= 2:
        img = img.filter(ImageFilter.GaussianBlur(radius=0.8))
        # lower contrast
        px = img.load()
    if degrade_level >= 3:
        img = img.filter(ImageFilter.GaussianBlur(radius=1.4))
        # simulate low brightness/contrast phone photo
        img = Image.eval(img, lambda p: int(p * 0.75 + 40))
    return img

manifest = []
# 30 "clean scan" bills, 30 "clean scan" orders, 10 degraded (phone-photo-like) of each
configs = [
    ("bill_clean", gen_bill_text, 0, 30),
    ("order_clean", gen_order_text, 0, 30),
    ("bill_degraded", gen_bill_text, 2, 10),
    ("order_degraded", gen_order_text, 2, 10),
]

for prefix, gen_fn, degrade, count in configs:
    for i in range(count):
        n_items = random.randint(8, 20)
        text = gen_fn(n_items)
        img = render_text_image(text, degrade_level=degrade)
        fname = f"{prefix}_{i:03d}.png"
        img.save(os.path.join(OUT, fname))
        manifest.append({"file": fname, "ground_truth": text, "type": "bill" if "bill" in prefix else "order",
                          "degraded": degrade > 0, "n_items": n_items})

with open("/home/claude/work/loadtest/manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)

print(f"Generated {len(manifest)} synthetic test images in {OUT}")
