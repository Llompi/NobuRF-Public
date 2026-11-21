"""
Draws Figures 2 and 3 of the landing page as inline SVG, Figure 2 from the validation report's data in
docs/validation/data/ and Figure 3 from the tuning run in site/figures/data/,
and writes them into site/index.html between the <!-- figure:NAME --> and <!-- /figure:NAME --> markers.

    python3 site/figures/build_figures.py

Each figure is drawn twice: a wide layout for desktop and a narrow one for phones, and index.html shows one of them
with a media query. The SVG uses CSS classes styled by index.html, so the figures share the page's fonts and colours.
"""
import csv
import json
import math
import re
from pathlib import Path

FIGURES_DIRECTORY = Path(__file__).parent
DATA_DIRECTORY = FIGURES_DIRECTORY / "data"
VALIDATION_DATA_DIRECTORY = FIGURES_DIRECTORY.parents[1] / "docs/validation/data"
PAGE_PATH = FIGURES_DIRECTORY.parent / "index.html"

WIDE_VIEWBOX_WIDTH = 1120
NARROW_VIEWBOX_WIDTH = 480
TARGET_FREQUENCY_GHZ = 5.8
FREQUENCY_RANGE_GHZ = (4.5, 7.5)


def read_openems_curve(case_name):
    """openEMS at 0.25 mm with its own mesh rule for thin copper (lines a third of a cell inside each edge)."""
    with open(VALIDATION_DATA_DIRECTORY / f"openems_{case_name}_line_r0.25_thirds.csv") as csv_file:
        rows = list(csv.DictReader(csv_file))
    return [float(row["f_ghz"]) for row in rows], [float(row["s11_db"]) for row in rows]


def read_noburf_graded_curve(case_name):
    """NobuRF on the graded mesh, 0.25 mm at the copper and six cells across the substrate (docs/validation.md section 3.1)."""
    frequencies_ghz, s11_values_db = [], []
    for line in (VALIDATION_DATA_DIRECTORY / f"graded/patch_{case_name}_graded_e0.25_d6.s1p").read_text().splitlines():
        if not line.strip() or line[0] in "!#":
            continue
        frequency_ghz, real_part, imaginary_part = (float(value) for value in line.split())
        frequencies_ghz.append(frequency_ghz)
        s11_values_db.append(20 * math.log10(math.hypot(real_part, imaginary_part)))
    return frequencies_ghz, s11_values_db


def minus(number_text):
    return number_text.replace("-", "−")


def dip_of(frequencies_ghz, s11_values_db):
    lowest_index = min(range(len(s11_values_db)), key=s11_values_db.__getitem__)
    return frequencies_ghz[lowest_index], s11_values_db[lowest_index]


def value_at(frequencies_ghz, s11_values_db, frequency_ghz):
    nearest_index = min(range(len(frequencies_ghz)), key=lambda index: abs(frequencies_ghz[index] - frequency_ghz))
    if abs(frequencies_ghz[nearest_index] - frequency_ghz) > 0.02:
        raise ValueError(f"no sample within 20 MHz of {frequency_ghz} GHz")
    return s11_values_db[nearest_index]


class PlotArea:
    """Maps frequency (GHz) and S11 (dB) to SVG coordinates inside one rectangle."""

    def __init__(self, left, top, width, height, lowest_db):
        self.left, self.top, self.width, self.height = left, top, width, height
        self.lowest_db = lowest_db

    def x(self, frequency_ghz):
        low, high = FREQUENCY_RANGE_GHZ
        return self.left + self.width * (frequency_ghz - low) / (high - low)

    def y(self, s11_db):
        clamped_db = max(self.lowest_db, min(0.0, s11_db))
        return self.top + self.height * clamped_db / self.lowest_db

    def path(self, frequencies_ghz, s11_values_db):
        points = [
            (self.x(frequency), self.y(value))
            for frequency, value in zip(frequencies_ghz, s11_values_db)
            if FREQUENCY_RANGE_GHZ[0] <= frequency <= FREQUENCY_RANGE_GHZ[1]
        ]
        if len(points) < 2:
            raise ValueError("a curve needs at least two points inside the frequency range")
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in points)

    def axes(self, decibel_ticks, frequency_ticks):
        parts = []
        for decibel in decibel_ticks:
            y = self.y(decibel)
            parts.append(f'<line class="grid" x1="{self.left}" x2="{self.left + self.width}" y1="{y:.1f}" y2="{y:.1f}"/>')
            parts.append(f'<text class="tick" x="{self.left - 12}" y="{y + 5:.1f}" text-anchor="end">{minus(str(decibel))}</text>')
        for frequency in frequency_ticks:
            x = self.x(frequency)
            parts.append(f'<text class="tick" x="{x:.1f}" y="{self.top + self.height + 28}" text-anchor="middle">{frequency:.1f}</text>')
        return "\n".join(parts)

    def frequency_label(self, y):
        return f'<text class="axis-label" x="{self.left + self.width / 2:.1f}" y="{y}" text-anchor="middle">frequency (GHz)</text>'


def svg_open(layout, viewbox_width, height, title_id, title):
    return (f'<svg class="figure-svg figure-{layout}" viewBox="0 0 {viewbox_width} {height}" role="img" aria-labelledby="{title_id}">\n'
            f'<title id="{title_id}">{title}</title>')


def decibel_label(x, y):
    return f'<text class="axis-label" transform="translate({x} {y:.0f}) rotate(-90)" text-anchor="middle">S11 (dB)</text>'


def figure_openems_comparison(layout):
    """Figure 2: NobuRF and openEMS on graded 0.25 mm meshes, edge-fed and inset-fed. Panels side by side when wide, stacked when narrow."""
    panels = [
        ("baseline", "Edge-fed", -10, (0, -2, -4, -6, -8, -10)),
        ("inset4", "Inset feed, 4 mm", -25, (0, -5, -10, -15, -20, -25)),
    ]
    if layout == "wide":
        viewbox_width, height, panel_width, panel_height = WIDE_VIEWBOX_WIDTH, 500, 430, 310
        panel_origins = [(84, 110), (84 + 430 + 110, 110)]
        frequency_ticks = (4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5)
    else:
        viewbox_width, height, panel_width, panel_height = NARROW_VIEWBOX_WIDTH, 860, 380, 250
        panel_origins = [(76, 110), (76, 110 + 250 + 130)]
        frequency_ticks = (4.5, 5.5, 6.5, 7.5)
    parts = [svg_open(layout, viewbox_width, height, f"figure-2-title-{layout}",
                      'S11 against frequency for NobuRF and openEMS. Edge-fed: NobuRF dips at 5.30 GHz to −7.9 dB, openEMS at '
                      '5.34 GHz to −8.2 dB. Inset-fed: both dip at 5.47 GHz, NobuRF to −21.5 dB, openEMS to −20.4 dB.'),
             f'<g class="legend" transform="translate({panel_origins[0][0]} 36)">',
             '<line class="curve-noburf" x1="0" x2="34" y1="0" y2="0"/><text x="44" y="6">NobuRF</text>',
             '<line class="curve-openems" x1="140" x2="174" y1="0" y2="0"/><text x="184" y="6">openEMS</text>',
             '</g>']
    for (case_name, panel_title, lowest_db, decibel_ticks), (left, top) in zip(panels, panel_origins):
        area = PlotArea(left, top, panel_width, panel_height, lowest_db)
        noburf_frequencies, noburf_s11 = read_noburf_graded_curve(case_name)
        openems_frequencies, openems_s11 = read_openems_curve(case_name)
        noburf_dip = dip_of(noburf_frequencies, noburf_s11)
        openems_dip = dip_of(openems_frequencies, openems_s11)
        parts.append(f'<text class="panel-title" x="{area.left}" y="{area.top - 26}">{panel_title}</text>')
        parts.append(area.axes(decibel_ticks, frequency_ticks))
        parts.append(f'<path class="curve-openems" d="{area.path(openems_frequencies, openems_s11)}"/>')
        parts.append(f'<path class="curve-noburf" d="{area.path(noburf_frequencies, noburf_s11)}"/>')
        label_x = area.x(max(noburf_dip[0], openems_dip[0])) + 16
        parts.append(f'<text class="annotation" x="{label_x:.1f}" y="{area.y(noburf_dip[1]) + 5:.1f}">'
                     f'<tspan class="label-noburf">{noburf_dip[0]:.2f}</tspan> / '
                     f'<tspan class="label-openems">{openems_dip[0]:.2f}</tspan> GHz</text>')
        parts.append(area.frequency_label(area.top + area.height + 62))
        parts.append(decibel_label(area.left - 62, area.top + area.height / 2))
    parts.append("</svg>")
    return "\n".join(parts)


def figure_tuning_run(layout):
    """Figure 3: S11 after each of the five edits, earlier steps fading back."""
    tuning_steps = json.loads((DATA_DIRECTORY / "tuning_run_0.5mm.json").read_text())
    if layout == "wide":
        viewbox_width, height = WIDE_VIEWBOX_WIDTH, 540
        area = PlotArea(84, 60, WIDE_VIEWBOX_WIDTH - 84 - 300, height - 140, -25)
        frequency_ticks = (4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5)
    else:
        viewbox_width, height = NARROW_VIEWBOX_WIDTH, 520
        area = PlotArea(76, 60, NARROW_VIEWBOX_WIDTH - 76 - 24, height - 150, -25)
        frequency_ticks = (4.5, 5.5, 6.5, 7.5)
    start_s11 = value_at(tuning_steps[0]["f_ghz"], tuning_steps[0]["s11_db"], TARGET_FREQUENCY_GHZ)
    final_s11 = value_at(tuning_steps[-1]["f_ghz"], tuning_steps[-1]["s11_db"], TARGET_FREQUENCY_GHZ)
    start_text = f'start {minus(f"{start_s11:.1f}")} dB'
    final_word = "after 5 edits" if layout == "wide" else "final"
    final_text = f'{final_word} {minus(f"{final_s11:.1f}")} dB'
    parts = [svg_open(layout, viewbox_width, height, f"figure-3-title-{layout}",
                      f'S11 after each of five edits. At 5.8 GHz it goes from {minus(f"{start_s11:.1f}")} dB '
                      f'at the start to {minus(f"{final_s11:.1f}")} dB after the trim slot.'),
             area.axes((0, -5, -10, -15, -20, -25), frequency_ticks)]
    target_x = area.x(TARGET_FREQUENCY_GHZ)
    parts.append(f'<line class="target" x1="{target_x:.1f}" x2="{target_x:.1f}" y1="{area.top - 10}" y2="{area.top + area.height}"/>')
    parts.append(f'<text class="muted" x="{target_x + 10:.1f}" y="{area.top - 22}">5.8 GHz target</text>')
    step_count = len(tuning_steps)
    for step_index, step in enumerate(tuning_steps[:-1]):
        opacity = 0.22 + 0.4 * step_index / (step_count - 2)
        parts.append(f'<path class="curve-earlier" style="opacity:{opacity:.2f}" d="{area.path(step["f_ghz"], step["s11_db"])}"/>')
    parts.append(f'<path class="curve-noburf" d="{area.path(tuning_steps[-1]["f_ghz"], tuning_steps[-1]["s11_db"])}"/>')
    parts.append(f'<circle class="point-earlier" cx="{target_x:.1f}" cy="{area.y(start_s11):.1f}" r="6"/>')
    parts.append(f'<circle class="point-final" cx="{target_x:.1f}" cy="{area.y(final_s11):.1f}" r="7"/>')
    if layout == "wide":
        label_x = area.left + area.width + 24
        for s11_db in (start_s11, final_s11):
            parts.append(f'<line class="leader" x1="{target_x + 10:.1f}" x2="{label_x - 8}" y1="{area.y(s11_db):.1f}" y2="{area.y(s11_db):.1f}"/>')
    else:
        label_x = target_x + 16
    parts.append(f'<text class="annotation halo" x="{label_x:.1f}" y="{area.y(start_s11) + 5:.1f}">{start_text}</text>')
    parts.append(f'<text class="annotation halo label-noburf" x="{label_x:.1f}" y="{area.y(final_s11) + 5:.1f}">{final_text}</text>')
    parts.append(area.frequency_label(height - 30))
    parts.append(decibel_label(22, area.top + area.height / 2))
    parts.append("</svg>")
    return "\n".join(parts)


def write_into_page(figure_name, svg_markup):
    page_text = PAGE_PATH.read_text()
    marker_pattern = re.compile(rf"(<!-- figure:{figure_name} -->)(.*?)(<!-- /figure:{figure_name} -->)", re.DOTALL)
    if not marker_pattern.search(page_text):
        raise SystemExit(f"index.html has no <!-- figure:{figure_name} --> markers")
    PAGE_PATH.write_text(marker_pattern.sub(lambda match: f"{match.group(1)}\n{svg_markup}\n{match.group(3)}", page_text))


if __name__ == "__main__":
    for figure_name, draw_figure in (("openems-comparison", figure_openems_comparison), ("tuning-run", figure_tuning_run)):
        write_into_page(figure_name, "\n".join(draw_figure(layout) for layout in ("wide", "narrow")))
    print("wrote Figures 2 and 3 into", PAGE_PATH)
