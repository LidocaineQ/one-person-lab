# Whitepapers

Owner: `one-person-lab`
Purpose: `whitepaper_source_root`
State: `active`
Machine boundary: Source prose and the family catalog for public whitepapers.
Generated HTML/PDF/verification bundles live under ignored `docs/site/latest/`.
Publication truth comes from the approved bundle plus an exact-byte public
readback receipt, not from this directory or a successful render alone.

Each whitepaper owns its prose and build profile. A repository may own more than
one whitepaper; OPL Framework currently owns both the OPL family narrative and
its independent architecture whitepaper. OPL Framework also owns the only
renderer and family release-set registry:

- `scripts/run-domain-whitepaper.ts`
- `scripts/opl-whitepaper-builder.ts`
- `scripts/whitepaper-style.css`
- `contracts/opl-framework/public-whitepaper-registry.json`

`npm run docs:whitepapers:family` builds the OPL family, OPL Framework, OPL App,
OPL Cloud, and MAS whitepapers through those profiles. It does not copy renderer
source into domain repos.
`npm run docs:whitepapers:family:release` additionally requires every selected
repo to be clean `main == origin/main`.

The editorial contract is purpose-first: explain the user problem, the design
choice, the user-visible consequence, a concrete scenario, and the trust
boundary. Profiles constrain artifact shape and public URLs; they must not pin
narrative section wording or turn the whitepaper into a feature checklist.

Current source:

- `opl-whitepaper.md` (OPL family design and product philosophy)
- `opl-framework-whitepaper.md` (Framework architecture and design philosophy)
- `index.md` (family catalog published at `/latest/whitepapers/`)
