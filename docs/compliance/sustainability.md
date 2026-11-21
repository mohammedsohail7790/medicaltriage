# Environmental commitment (NFR-170)

What can honestly be said, and what has to come from the providers.

## The product's own footprint

- It runs on a serverless platform that scales to the load and, for the SIT and UAT environments, down to zero instances, so idle environments do not hold compute (stage keeps one instance warm).
- Logs are kept for a defined time, then moved to cold storage and deleted on Qatar Airways' rule; backups have a set retention. Data is not kept without a rule.
- Responses are compressed, and a lighter response is sent on slow connections, so less data moves.
- Regions are chosen for residency first; the default is the Doha region.

## What the providers publish

The cloud provider's carbon-free-energy and efficiency reports, and the sustainability commitments of the messaging and email providers, are the providers' own statements. **IRISSTAR must attach the current published documents for the provider used in Qatar Airways' tenant**; this repository does not reproduce them, and no figure from them is claimed here.

## What IRISSTAR still has to supply

- A statement of IRISSTAR's own environmental policy, if it has one.
- The provider's sustainability documents for the chosen region and services.
- The cloud provider's emissions reporting for the tenant, once it exists, if Qatar Airways wants it reported.
