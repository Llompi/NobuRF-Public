# De-embedding ports

A lumped port is a 50 Ω source in one column of cells. At the end of a
microstrip line that column is a discontinuity of its own: on a 50 Ω line
on RO4003C a plain 20 mm thru reflects |S11| = 0.14 at 3 GHz and 0.41 at
5 GHz ([textbook-exam.md](textbook-exam.md)), so a raw circuit result
mostly measures its ports. De-embedding removes the port and a length of
the feed line it drives, and refers the results to a plane on the line, as
a VNA calibrated at the end of its cables would.

## Asking for it

Give a lumped port a `deembed` length:

```json
"ports": [
  { "id": "in", "x": "-17.16 mm", "y": "0 mm", "between": ["gnd", "top"],
    "reference_impedance_ohm": 50, "deembed": { "length": "10 mm" } }
]
```

The port must sit on the end of a straight feed at least that long. NobuRF
reads the feed from the project and works out the rest:

- **which way it runs and on which layer**: the one of the port's two layers
  where copper runs straight from the port for the whole length, with the
  other layer solid under it;
- **its width**, which must not change along the length (to 1 µm);
- **the other copper layers**, each of which must be solid or empty around
  the feed (a stripline's second ground is solid; an unrelated layer is
  empty).

It refuses, and says why, when the feed is not a plain strip: a taper or a
bend within the length, copper on the same layer within three substrate
heights (at least one strip width) of the strip or behind the port (a
coplanar ground, a neighbouring trace, a port in the middle of a line),
another port or a component on the feed, or a reference layer that is not
solid under the feed and the board behind the port. On a uniform mesh the
length must be a whole number of half cells, so the kit's thru is whole
cells long; its line standards are then rounded to whole cells.

Run `noburf solve` as usual. For every distinct feed it then builds a
calibration kit from the project (same stackup, materials, mesh, boundaries
and loss settings; the feed alone on a board as wide as the project's, up
to ten substrate heights each side), solves it, and removes each port's
error box from the S-matrix. Ports whose feeds match share one kit, so a
symmetric two-port solves one. A kit is a thru (two feeds back to back)
and one to four longer lines, each a two-port solve on its own board
(the longest line up to 150 mm when the band starts low). Kits run with the
project's energy stop and step limit; a kit that hits the step limit adds a
warning naming it. The workbench does the same when a project asks for it,
and lists the de-embedded ports with the solve's facts.

## What changes in the results

- `s11.s1p` or `sparams.s<N>p`, the S11 dip, Z_in at `outputs.zin_at_ghz`
  and the Z of every run refer to the reference planes, `length` along each
  feed, in each port's `reference_impedance_ohm`.
- The results at the ports are kept beside them as `s11.raw.s1p` or
  `sparams.raw.s<N>p`.
- `result.json` gains a `deembedding` record: per port the feed that was
  found (direction, layers, width, offset), the kit (its band, the extra
  line lengths, solves, or which port's kit it reused), and what the kit
  measured about the line: its impedance in the low-frequency limit, and per
  frequency its effective permittivity and loss. It also runs the passivity
  and reciprocity checks on the de-embedded S.
- `self_check` still describes the solve at the ports: the mesh error bar is
  the raw solve's.
- The far field and the field views are unchanged: de-embedding is network
  arithmetic on S, not a change to the fields.

## How it works

The error box of a port is the ABCD matrix of "port, then feed" from the
external port to the reference plane. The kit measures it by the thru-line
method (Engen and Hoer, 1979), with the mirror symmetry of the thru
standing in for the reflect standard, the same calibration the textbook
exam ran outside NobuRF (`scripts/textbook_exam/network.py`):

- The thru is the error box followed by its mirror image, `T = A flip(A)`.
- A line standard adds ΔL of uniform line between the halves, so
  `M_line T⁻¹ = A L A⁻¹`. Its eigenvalues are `exp(±γ ΔL)` whatever the port
  does (Marks, 1991), which gives the line's propagation constant γ, and its
  eigenvector for `exp(+γ ΔL)` is `A [Z_line, 1]ᵀ`. With `det A = 1`
  (reciprocity), that fixes A up to the line impedance.
- No thru-line set can measure the line impedance. NobuRF takes it in the
  limit f → 0, where the port's parasitics vanish: `√(B/C)` of the longest
  line, read through the symmetric half of the thru, fitted as `Z₀ + c f²`
  at the kit frequencies up to where the feed is 30° long. The kit's band
  is the project's, extended down and refined where needed to have six
  points there.
- On a uniform mesh the kit's board, strip and port sit at the same offsets
  from the port's grid node as the project's, so the kit meshes the same
  cells. The port is on that node, so the reference plane is `length` from
  the node, which is under half a cell from the port as drawn.
- The thru fixes A only up to its sign; NobuRF picks the sign nearer a line
  of half the thru's transmission phase, so the transmission phase stays
  right through a quarter-wave feed.
- At each frequency the line standard whose measured phase is nearest 90°
  is used: the phase of the eigenvalues of line × thru⁻¹, folded to 0 to
  180°, so an error in the εeff estimate cannot pick a line that is in fact
  near 0 or 180°. The estimate only tells the two eigenvalues apart. The
  line lengths are designed from the thru's delay to cover the band at 25
  to 155°, the longest at least two feeds long (for the impedance fit) and
  at most 150 mm. Where no line is at least 20° from 0
  and 180° (below the longest line's range), the symmetric half of the thru
  stands in, which keeps part of the port's reflection; `half_thru_ghz`
  lists those frequencies and a warning says so.
- Each de-embedded port's fixture S is removed from the measured S-matrix:
  with the fixtures on the diagonal and `M = (S_m − F11) F21⁻¹`, the
  de-embedded `S = (F12 + M F22)⁻¹ M`
  ([src/engine/deembed.ts](../src/engine/deembed.ts)).

## Limits

- **Lumped ports on straight strips only.** SMA and coax-probe ports are
  already referred to their flange. Coplanar waveguide, differential feeds
  and bends need other standards.
- **The reference impedance is the line's low-frequency impedance.** A
  microstrip's impedance rises with frequency by about 1 % over a few GHz
  (validation.md section 7.3). TRL refers results to the line's actual
  impedance, which NobuRF then scales with that single number, so this
  dispersion is not in the de-embedded result.
- **The kit approximates the feed's surroundings.** Its board is the feed
  alone, at most ten substrate heights each side; copper further away in the
  project is not in it, and the kit's mesh is graded around the kit's own
  copper, not the project's.
- **The design agent** (`npm run design`) still scores designs at the port.

## Validation

[`scripts/validate/deembed.ts`](../scripts/validate/deembed.ts)
(`npm run validate:deembed`) solves three cases (a plain line, a
quarter-wave section with two feed lengths, an alumina line) with the
functions `noburf solve` uses; results in
[`docs/validation/data/deembed.json`](validation/data/deembed.json) and
[validation.md](validation.md) section 7.8. On the exam's own stored kit
files the line impedance and the error box, sign included, match the
textbook exam's Python calibration to 1e-9 (tests/deembed.test.ts). Both
pick the box's sign as the one nearer an ideal line of half the thru's
phase.
