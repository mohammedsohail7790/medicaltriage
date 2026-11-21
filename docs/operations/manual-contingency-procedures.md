# Manual contingency procedures (NFR-095)

**Draft for Qatar Airways to confirm.** The product offers no automated fallback to another system; when part of it is unavailable, people follow a manual procedure. These are the procedures the product's design supports. Qatar Airways' own clinical governance owns the final wording, the paper forms and who is told. Nothing here has been rehearsed with Qatar Airways staff.

## The principle

Patient safety first: if a nurse cannot rely on the screen, they use the paper pathway and the telephone, and record the case in the system afterwards. The system never blocks a nurse from escalating a patient.

## Situations

| Situation | What the nurse does | What the service manager does | Afterwards |
|---|---|---|---|
| The application is unreachable | Use the paper triage form and the approved protocol booklet; escalate by telephone to the teleconsultant or emergency services as the protocol says | Declare the incident, tell staff, start the status log, call the on-call engineer | Enter each case with its original time; the audit trail shows late entry |
| The application works but the protocol content will not load | Use the booklet for the protocol; the red-flag and emergency questions still apply | As above | Report the content fault |
| The EMR write-back is down | The note is saved in the encounter; copy it from the screen to the record by hand if the patient's care needs it now | Check the dead-letter list and replay when the EMR returns | Confirm every queued note reached the record |
| Email, SMS or WhatsApp is down | Telephone the staff member; log the call in the case note | Tell the nurse which channels are affected | Send the letters or messages that were held |
| The teleconsultant service is unavailable | Escalate by telephone to the on-call physician; record the answer in the case note | Tell the nurse the alternate contact | Attach the physician's answer to the case |
| Sign-in or single sign-on is down | A named break-glass account (kept sealed) signs the manager in; nurses wait for restoration or use paper | Authorise and log the break-glass use | Review every break-glass use; rotate the account's password |
| Region loss | Paper pathway as for an unreachable application | The disaster-recovery steps in `docs/operations/availability-and-recovery.md` | Rehearse and review |

## Before go-live

- Qatar Airways supplies the paper forms, the booklet, the escalation telephone numbers, and who may authorise a break-glass sign-in.
- The procedures are rehearsed once with real nurses, and the cases entered afterwards are checked.
- A printed copy is kept where the nurses sit, and checked every six months.
