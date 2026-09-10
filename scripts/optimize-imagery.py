#!/usr/bin/env python3
"""
optimize-imagery.py - turn the raw brand-photo drop into bundled app assets.

Why this exists:
  The Proton drop is 53 files / ~16 MB of 1400-1700px PNG/WebP/JPEG. Two of
  those facts are shipping blockers:
    * WebP does NOT decode on iOS with React Native's default image loader,
      so a bundled .webp renders blank on iPhone while looking fine on
      Android.
    * A 2 MB PNG decoded into a 200dp card wastes RAM and lands the decode
      cost on the UI thread (see CLAUDE.md "app feels laggy" - every jank
      bucket measured there was Slow UI thread, not GPU).

  So every asset is re-encoded to progressive JPEG at the size its ROLE
  actually renders at. Source files stay untouched in the drop folder.

Usage:  python scripts/optimize-imagery.py [--check]
        --check  verify outputs exist without writing (CI gate)
"""
import sys
import os

try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit("Pillow required:  python -m pip install Pillow")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "Proton Drive Download - 2026-08-25")
OUT = os.path.join(REPO, "src", "assets", "imagery")

# Width (px) each role is encoded at - roughly 3x the dp width the role
# renders at, which is the crispest a phone can actually show.
ROLE_WIDTH = {
    "hero": 1080,      # full-bleed hero card
    "card": 720,       # half-width module / service card
    "row": 1080,       # full-width dashboard nav row (icon + copy + chevron)
    "wide": 540,       # half-width short tile (VBG quick action / mini card)
    "tile": 360,       # small trust tile
    "portrait": 512,   # CPO / client avatar (max dimension)
}
QUALITY = {"hero": 80, "card": 80, "row": 80, "wide": 78, "tile": 78, "portrait": 82}

# Render aspect (w/h) each role is CROPPED to before resizing, so `cover` at
# render time no longer decides which part of the art survives.
ROLE_ASPECT = {"hero": 1.52, "card": 1.30, "tile": 0.78, "row": 4.8, "wide": 2.9}

# Roles whose CARD is far wider than any drop can be cropped to. A 4.8:1 crop
# would take a thin horizontal band out of the middle of the artwork and throw
# the subject away, so these are PLATED instead: the art is cut to its
# meaningful (bright) region and right-aligned on an obsidian canvas at the
# role aspect. Same reasoning as scripts/compose-card-art.py, which does this
# for the portrait AI-Itinerary drop - the copy field on the left is then real
# obsidian and the whole subject survives `cover`.
PLATE_ROLES = ("row", "wide")
OBSIDIAN = (7, 9, 13)               # D.bg - the app surface the card sits on
# Free canvas kept to the RIGHT of the art, as a fraction of canvas width. The
# nav row's chevron lives there; a plate that ran to the edge sat under it.
PLATE_RIGHT_MARGIN = {"row": 0.045, "wide": 0.05}
# Widest the art plate may run, as a fraction of canvas width. Without a cap a
# drop whose subject happens to be wide sprawls under the row's sub-line, and
# the plates start at different x across the list - which reads as sloppy
# rather than as one designed language.
PLATE_MAX_W = {"row": 0.40, "wide": 0.58}
# Art height as a fraction of the canvas, so a card slightly WIDER than the
# role aspect (tablet, fontScale reflow) crops obsidian rather than artwork.
PLATE_H_FRAC = 0.92

# Sources under this folder are purpose-made card art: a mostly-black field
# with the subject in one region (founder 2026-08-26: "the unused background
# part not to be included - the part meaningful need"). They get the
# content-aware crop; full-bleed photos from the original drop keep the
# whole frame.
SMART_DIRS = (
    "Proton Drive Download - 2026-08-26/",
    # Founder drop 2026-08-31 - card art for every NON-Pro dashboard (agent /
    # org, departmental, VBG). Same language as the 08-26 set: a black field
    # with the subject in one region.
    "Bravo other dashboard/",
)


def bright_box(im):
    """The meaningful region of a purpose-made art drop, with 8% breathing room.

    Returns None when the frame is uniformly dark (nothing to isolate).
    """
    g = im.convert("L")
    mask = g.point(lambda v: 255 if v > 28 else 0)
    box = mask.getbbox()
    if not box:
        return None
    W, H = im.size
    l, t, r, b = box
    pw, ph = int((r - l) * 0.08), int((b - t) * 0.08)
    return (max(0, l - pw), max(0, t - ph), min(W, r + pw), min(H, b + ph))


def _to_obsidian(art):
    """Sit a plate's GROUND on the app surface.

    Most of the drop is authored on pure black, but not all of it (the Org
    Chart art has a grey studio ground). Pasted as-is that plate reads as a
    lighter rectangle stuck onto the obsidian card - the feather softens its
    edge but cannot fix its interior. So the border ring is sampled and the
    excess over #07090D subtracted, which lands the ground on the surface and
    leaves the bright subject essentially untouched.
    """
    w, h = art.size
    px = art.convert("RGB").load()
    ring = ([px[x, 0] for x in range(0, w, 4)] + [px[x, h - 1] for x in range(0, w, 4)]
            + [px[0, y] for y in range(0, h, 4)] + [px[w - 1, y] for y in range(0, h, 4)])
    ground = tuple(sorted(c[i] for c in ring)[len(ring) // 2] for i in range(3))
    delta = tuple(max(0, ground[i] - OBSIDIAN[i]) for i in range(3))
    if max(delta) <= 4:
        return art
    return ImageChops.subtract(art.convert("RGB"), Image.new("RGB", art.size, delta))


def plate(im, role):
    """Right-align the art on an obsidian canvas at the role aspect.

    Used for the roles a crop cannot reach (see PLATE_ROLES).
    """
    aspect = ROLE_ASPECT[role]
    box = bright_box(im)
    art = _to_obsidian(im.crop(box) if box else im)

    canvas_h = int(round(art.height / PLATE_H_FRAC))
    canvas_w = int(round(canvas_h * aspect))
    margin = int(round(canvas_w * PLATE_RIGHT_MARGIN[role]))
    # A drop wider than the canvas allows is scaled DOWN to fit rather than
    # cropped - the whole point of a plate is that the subject survives whole.
    max_w = min(canvas_w - margin, int(round(canvas_w * PLATE_MAX_W[role])))
    if art.width > max_w:
        art = art.resize((max_w, max(1, round(art.height * max_w / art.width))), Image.LANCZOS)

    canvas = Image.new("RGB", (canvas_w, canvas_h), OBSIDIAN)
    canvas.paste(art, (canvas_w - margin - art.width, (canvas_h - art.height) // 2),
                 _feather(art.size))
    return canvas


# Edge ramps for a plated asset, as a fraction of the art's own width/height.
# Without them the plate is a rectangle of art pasted onto obsidian and its
# border reads as a hard seam - obvious on any drop whose ground is not pure
# black (the Org Chart art sits on grey). The LEFT ramp is much longer because
# that edge points INTO the copy field.
PLATE_FEATHER = {"left": 0.38, "right": 0.12, "top": 0.24, "bottom": 0.24}


def _feather(size):
    """Alpha mask that melts a plated art's edges into the obsidian canvas."""
    w, h = size
    mask = Image.new("L", size, 255)
    px = mask.load()
    ramps = (
        (int(w * PLATE_FEATHER["left"]), lambda x, y: x),
        (int(w * PLATE_FEATHER["right"]), lambda x, y: w - 1 - x),
        (int(h * PLATE_FEATHER["top"]), lambda x, y: y),
        (int(h * PLATE_FEATHER["bottom"]), lambda x, y: h - 1 - y),
    )
    for span, dist in ramps:
        if span <= 0:
            continue
        for y in range(h):
            for x in range(w):
                d = dist(x, y)
                if d < span:
                    a = int(255 * d / span)
                    if a < px[x, y]:
                        px[x, y] = a
    return mask


def smart_crop(im, role):
    """Crop to the meaningful (bright) region, grown to the role aspect."""
    aspect = ROLE_ASPECT.get(role)
    if aspect is None:
        return im
    box = bright_box(im)
    if not box:
        return im
    W, H = im.size
    l, t, r, b = box
    bw, bh = r - l, b - t
    if float(bw) / bh < aspect:
        need = int(bh * aspect)
        l = max(0, l - (need - bw) // 2)
        r = min(W, l + need)
        l = max(0, r - need)
    else:
        need = int(bw / aspect)
        t = max(0, t - (need - bh) // 2)
        b = min(H, t + need)
        t = max(0, b - need)
    return im.crop((l, t, r, b))

# semantic key -> (source filename, role)
MANIFEST = {
    # -- Booking / Secure home ------------------------------------------
    "heroBookProtection": ("Proton Drive Download - 2026-08-26/Book Close Protection.png", "hero"),
    "heroMissionActive": ("bravo-secure-night-transfer-route.jpg", "hero"),
    "trustEncryption": ("Proton Drive Download - 2026-08-26/AES-256.png", "tile"),
    "trustVettedCpos": ("Proton Drive Download - 2026-08-26/Vetted CPOs.png", "tile"),
    "trustLiveTracking": ("Proton Drive Download - 2026-08-26/Live Tracking.png", "tile"),
    "trustSecureComms": ("Proton Drive Download - 2026-08-26/Secure Comms.png", "tile"),

    # -- Secure Pro modules ---------------------------------------------
    # Founder 2026-08-30: the new AI-Itinerary art must render WHOLE, not
    # cropped. It is authored portrait, so it is pre-composed onto the
    # 1200x900 card canvas (art right, obsidian copy field left) and lives
    # OUTSIDE SMART_DIRS so smart_crop cannot re-crop it back.
    "proItinerary": ("AI Itinerary card 1200x900.png", "card"),
    "proDesignatedTeam": ("Proton Drive Download - 2026-08-26/Designated Team.png", "card"),
    "proLiveMap": ("Proton Drive Download - 2026-08-26/Live Map.png", "card"),
    "proBookingRequests": ("Proton Drive Download - 2026-08-26/Booking Requests.png", "card"),
    "proRiskIntel": ("Proton Drive Download - 2026-08-26/Risk Intelligence.png", "card"),
    "proReports": ("Proton Drive Download - 2026-08-26/Reports & Logs.png", "card"),

    # -- Agent / Org dashboard (founder drop 2026-08-31) ------------------
    # The agent dashboard keeps its full-width NAV ROWS (founder call
    # 2026-08-31), so this art is plated to the row aspect - see PLATE_ROLES.
    "agentMissions": ("Bravo other dashboard/Missions.png", "row"),
    "agentJobStandby": ("Bravo other dashboard/No Active Mission.png", "row"),
    "agentJobPortal": ("Bravo other dashboard/Job Portal.png", "row"),
    "agentCompliance": ("Bravo other dashboard/Compliance.png", "row"),
    "agentRoster": ("Bravo other dashboard/Service Provider Status.png", "row"),
    "agentOrgChart": ("Bravo other dashboard/Org Chart.png", "row"),
    "agentDepartmental": ("Bravo other dashboard/Departmental Management.png", "row"),
    "agentRegion": ("Bravo other dashboard/Dispatch Region.png", "row"),
    "agentEarnings": ("Bravo other dashboard/Organisation Earnings.png", "row"),
    "agentManagerPerms": ("Bravo other dashboard/Manager Permissions.png", "row"),
    "agentIntelFeed": ("Bravo other dashboard/Regional News Feed Placeholder.png", "row"),

    # -- Departmental / enterprise workspace ------------------------------
    "deptSecureConnection": ("Bravo other dashboard/Secure Connection.png", "row"),
    "deptAttendance": ("Bravo other dashboard/Attendance & Shifts.png", "card"),
    "deptIncident": ("Bravo other dashboard/Report Incident.png", "card"),
    "deptChannels": ("Bravo other dashboard/Department Channels.png", "card"),
    "deptApprovals": ("Bravo other dashboard/Invite Code.png", "card"),
    "deptWorkspaces": ("Bravo other dashboard/Workspaces.png", "hero"),

    # -- Virtual Bodyguard dashboard --------------------------------------
    # The VBG quick-action tiles and intel mini-cards are short and half-width,
    # so they take the `wide` plate rather than the 4:3 card crop.
    "vbgEmergencyCall": ("Bravo other dashboard/Contact Emergency Services.png", "wide"),
    "vbgNextOfKin": ("Bravo other dashboard/Next of Kin.png", "wide"),
    "vbgRequestSupport": ("Bravo other dashboard/Request Support.png", "wide"),
    "vbgSecurityRisk": ("Bravo other dashboard/Security Risk.png", "wide"),
    "vbgNearby": ("Bravo other dashboard/Nearby Emergency Services.png", "wide"),
    "vbgLiveLocation": ("Bravo other dashboard/Virtual Bodyguard Live Location.png", "card"),
    "vbgGeoRisk": ("Bravo other dashboard/Georisk Analysis.png", "hero"),
    "newsRegionalFeed": ("Bravo other dashboard/Regional News Feed Placeholder.png", "hero"),

    "proLinkedMembers": ("1000063784_website_196kb.webp", "card"),
    "proBilling": ("1000063814_website_196kb.webp", "card"),

    # Credits/balance destination — same premium desk language as the Billing
    # card that navigates here, so the card and its screen read as one place.
    "creditsHero": ("1000063814_website_196kb.webp", "hero"),
    # CPO "no active mission" — an officer standing by, not an empty illustration
    "cpoStandby": ("1000063785_website_196kb.webp", "card"),
    # Workspace / org empty state
    "workspaceEmpty": ("1000063783_website_196kb.webp", "card"),

    "orgFinance": ("1000063805_website_196kb.webp", "hero"),

    "requestProtection": ("Proton Drive Download - 2026-08-26/Request Protection.png", "hero"),

    # -- Plan / package / job heroes -------------------------------------
    "proHero": ("1000063760.png", "hero"),
    "packageHero": ("1000063784_website_196kb.webp", "hero"),
    "jobOfferHero": ("1000063804_website_196kb.webp", "hero"),

    # -- Services --------------------------------------------------------
    "svcCloseProtection": ("bravo-secure-close-protection-arrival.jpg", "card"),
    "svcExecTransport": ("bravo-executive-transfer-arrival.jpg", "card"),
    "svcAviation": ("bravo-private-aviation-transfer.jpg", "card"),
    "svcFamily": ("bravo-family-secure-transfer.jpg", "card"),
    "svcVehicleSupport": ("bravo-secure-vehicle-support-night.jpg", "card"),
    "svcConsultation": ("bravo-secure-client-consultation.jpg", "card"),

    # Messenger on a MODULE card: a principal using the app at night reads as
    # executive protection; the desktop chat UI reads as enterprise SaaS.
    "messengerExec": ("1000063770.png", "card"),

    # -- Virtual Bodyguard ----------------------------------------------
    "vbgHero": ("bravo-virtual-bodyguard-sos-app.jpg", "hero"),
    "vbgCompanion": ("Virtual Body guard.jpeg", "card"),
    "vbgRiskAwareness": ("bravo-executive-mobile-risk-awareness.jpg", "card"),

    # -- Messenger / comms ----------------------------------------------
    "messengerHero": ("bravo-comms-secure-platform.jpg", "hero"),
    "messengerVault": ("1000063776_website_196kb.webp", "card"),

    # -- Ops / agency ----------------------------------------------------
    "opsCenter": ("1000063815_website_196kb.webp", "hero"),
    "opsOperator": ("bravo-control-system-operator.jpg", "card"),
    "opsDispatch": ("1000063816_website_196kb.webp", "card"),
    "opsJourneyMonitoring": ("bravo-control-system-journey-monitoring.jpg", "card"),
    "opsBriefing": ("bravo-secure-operations-briefing.jpg", "card"),
    "opsSupport": ("1000063817_website_196kb.webp", "card"),

    # -- Auth / onboarding -----------------------------------------------
    "authWelcome": ("bravo-executive-transfer-arrival.jpg", "hero"),
    "authClientApp": ("bravo-client-secure-mobile-app.jpg", "hero"),

    # -- People -----------------------------------------------------------
    "cpo1": ("CPO1.jpg", "portrait"),
    "cpo2": ("CPO2.jpg", "portrait"),
    "cpo3": ("CPO3.jpg", "portrait"),
    "cpo8": ("CPO8.jpg", "portrait"),
    "cpo9": ("CPO9.jpg", "portrait"),
    "cpo10": ("CPO10.jpg", "portrait"),
    "client1": ("Client 1.jpg", "portrait"),
    "client3": ("Client 3.jpg", "portrait"),
    "client4": ("Client 4.jpg", "portrait"),
    "clientFam": ("Client fam 1.jpg", "portrait"),
    "clientKids": ("Client kids 2.jpg", "portrait"),
}


def build(check_only=False):
    if not os.path.isdir(SRC):
        sys.exit("source drop not found: " + SRC)
    os.makedirs(OUT, exist_ok=True)

    total = 0
    missing = []
    report = []

    for key, (fname, role) in sorted(MANIFEST.items()):
        spath = os.path.join(SRC, fname)
        if not os.path.isfile(spath):
            sys.exit("MANIFEST references a missing source file: " + fname)
        dpath = os.path.join(OUT, key + ".jpg")

        if check_only:
            if not os.path.isfile(dpath):
                missing.append(key)
            continue

        im = Image.open(spath).convert("RGB")
        if role in PLATE_ROLES:
            im = plate(im, role)
        elif fname.startswith(SMART_DIRS):
            im = smart_crop(im, role)
        target = ROLE_WIDTH[role]
        if role == "portrait":
            im.thumbnail((target, target), Image.LANCZOS)
        elif im.width > target:
            im = im.resize(
                (target, round(im.height * target / im.width)), Image.LANCZOS
            )

        im.save(dpath, "JPEG", quality=QUALITY[role], optimize=True, progressive=True)
        sz = os.path.getsize(dpath)
        total += sz
        report.append((key, role, "%dx%d" % (im.width, im.height), "%dKB" % (sz // 1024)))

    if check_only:
        if missing:
            sys.exit(
                "imagery out of date, run scripts/optimize-imagery.py: "
                + ", ".join(missing)
            )
        print("imagery OK - %d assets present" % len(MANIFEST))
        return

    w = max(len(r[0]) for r in report)
    for key, role, dim, sz in report:
        print("  %s  %s %s %s" % (key.ljust(w), role.ljust(8), dim.rjust(10), sz.rjust(8)))
    print("\n%d assets -> %s" % (len(report), OUT))
    print("total bundled size: %.2f MB" % (total / 1024.0 / 1024.0))


if __name__ == "__main__":
    build(check_only="--check" in sys.argv)
