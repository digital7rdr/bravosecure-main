# Messenger — test coverage sweep + all bugs fixed (2026-07-23)

**What you asked for:** check the messenger module's tests, write tests for every small function
(active status, ticks, reply, audio, and the rest), find bugs — then fix them all, make sure they
can never come back silently, and push.

**What you got:** 11 new test files, **147 new tests**, **12 bugs found and 10 fixed**, 1 retracted
as not-a-bug, and a rule added to `CLAUDE.md` so the whole messenger suite has to stay green on
every future change.

---

## 0. Before vs after — what you'll actually notice

| #   | Situation                                                                    | Before                                                                                | After                                                      |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | You reply to a message in a **group**                                        | Everyone else got a plain message — no quote, no jump. **Only you saw it as a reply** | Everyone sees the quoted message and can tap to jump to it |
| 2   | You reply in a group **on a bad connection**                                 | Reply sent later, still stripped of the quote                                         | Reply survives the queue and arrives complete              |
| 3   | A group member **can't open your message** (reinstalled / restored a backup) | You kept seeing ✓✓ — unless they happened to be the first person sent to              | Any member's failure now shows up instead of a false ✓✓    |
| 4   | You **record a voice note**                                                  | The raw unencrypted recording stayed in phone storage indefinitely                    | Deleted as soon as the encrypted copy exists               |
| 5   | You **play a voice note** after recording one                                | Played quiet / through the earpiece until you restarted the app                       | Normal volume                                              |
| 6   | You tap **Send** just as the 5-min limit hits                                | Same clip could be **sent and cancelled at once**                                     | One clip, one outcome                                      |
| 7   | You **leave the screen while recording**                                     | Microphone stayed on in the background                                                | Recorder shuts down properly                               |
| 8   | A contact **comes online then goes offline**                                 | Their "Last seen …" disappeared for the rest of the session                           | "Last seen" is kept                                        |
| 9   | A contact hides "last seen"                                                  | (unchanged, server-enforced)                                                          | Client now also refuses to show a remembered time — safer  |
| 10  | A contact's **phone clock runs fast**                                        | Showed "Active recently" while offline, and the offline banner never appeared         | Shows offline correctly                                    |
| 11  | You saved a number as **`1 415 555 0100`** (no `+`)                          | Number was mangled, so that person **silently never appeared as being on Bravo**      | Matched correctly                                          |
| 12  | Someone **shares a link**                                                    | Many normal sites showed a bare link with no title or image                           | Preview shows properly                                     |
| 13  | A link preview **fails once** (bad signal)                                   | That link never got a preview again, ever                                             | Retries next time you see it                               |

Two things a user will _not_ see, but matter:

- A modified/hostile app could previously push an unlimited-size "quoted text" blob into your
  database and backups. Now capped.
- Three abandoned copies of networking code were deleted — they had already drifted out of sync
  with the real ones and were a trap for whoever touched them next.

---

## 1. The two bugs that were actually hurting users

Everything else on this page is smaller than these two.

### Group replies were not replies

If you replied to someone in a **group** chat, **nobody else saw it as a reply.** No quoted message
above it, and tapping it didn't jump anywhere — it arrived as an ordinary message.

The nasty part is why nobody caught it: **on your own screen it looked perfect.** The app saved the
reply on your copy of the message, but never actually put it in the envelope it sent out. So the
sender sees a correct reply, everyone else sees a plain message. One-to-one replies were always
fine — only groups were broken.

Fixing it took **five separate places**, not one. The obvious one is the message you send while
online. The other four are the paths used when you're **offline or your connection hiccups** — the
app parks the message and re-sends it later, and each of those parking spots was also dropping the
reply. Fix only the first and a reply typed on a bad connection still arrives stripped.

### A failed group message could still show two ticks

When someone's phone can't open a message (they reinstalled the app, restored a backup, cleared
data), their phone tells you so and your message should stop showing as delivered.

That worked **only for whichever group member the app happened to send to first.** For everyone
else the signal was thrown away — you kept seeing ✓✓ for a message that person will never read.
Same event, different result, purely depending on send order.

Now any member's failure registers. One honest note: in a group this is deliberately
**pessimistic** — if one person out of five can't open it, the message shows as failed for the
whole group. I chose that over silently pretending everything was delivered, but a proper
"delivered to 4 of 5" display is a bigger change and I've written it up as an open question rather
than quietly deciding it for you.

---

## 2. Your own voice recordings were being left on the phone

When you record a voice note, the app records it, encrypts it, and uploads it. **It was never
deleting the original unencrypted recording.** Your actual audio sat in the app's storage until
Android or iOS decided to clean up — which could be a long time.

Now it's deleted the moment the encrypted copy exists.

There was a real trap here worth knowing about: the tempting version of this fix — "delete the file
after uploading" — would have **deleted photos out of your gallery** when you send a picture,
because a photo you pick is also "a file the app just uploaded". The deletion is therefore locked
to files the app itself created, in the app's own private folders, and a test makes sure only the
voice-note path can ever trigger it.

**Three more voice-note problems fixed at the same time:**

- **Recording made later playback quiet.** Recording switches the phone into "recording mode" and
  the app never switched it back, so voice notes afterwards played quietly or out of the earpiece
  until you restarted the app.
- **A clip could be sent AND cancelled at once.** If the 5-minute auto-stop fired at the same moment
  you tapped Send (or you tapped Send and Delete together), the app processed the same recording
  twice — one path sent it, the other errored and cancelled it.
- **Leaving the screen mid-recording left the microphone on.** Nothing shut the recorder down, so
  the mic stayed live in the background.

⚠️ These four need a **real phone check** — they're in code that can't be tested automatically. The
tests I added will catch someone _deleting_ the fixes later, but they can't prove the microphone
actually releases. Worth 5 minutes on a device: record → send → play, then record → navigate away.

---

## 3. Smaller fixes

| What was wrong                                  | What you'd have seen                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "Last seen" was being wiped                     | Someone comes online, then goes offline — their "Last seen …" line vanished for the rest of the session                             |
| Clock skew showed offline people as active      | A contact whose phone clock ran fast showed "Active recently" and the "they're offline" banner never appeared                       |
| Contacts saved with a country code were mangled | Saving a number as `1 415 555 0100` (no `+`) produced a wrong number, so that person **silently never showed up as being on Bravo** |
| Link previews often failed                      | Many normal websites produced a bare link with no title/image, and one failed load meant that link **never** got a preview again    |
| Long quoted replies weren't limited             | A modified app could send a huge "quoted text" blob into your database and backups                                                  |
| Duplicate unused networking code                | Three abandoned copies of networking code nobody ran, already out of sync with the real ones — deleted                              |

---

## 4. One thing I got wrong, and one I over-claimed

I'd rather flag these than let them sit in the record.

**"Presence has no staleness check" — I was wrong, retracted.** I reported that if someone's phone
died, they'd show as online forever. **There is a proper system for this**, I just didn't find it:
it lives on the server (`presence.cron.ts`), runs every 5 minutes, and there's a 2-minute
"heartbeat lease" underneath it. Someone whose phone dies goes offline in about 7 minutes. I'd
searched only the app folder, not the server folder.

I also **did not** add a client-side timeout, even though that's what my original report suggested —
it would have made things worse. The app only gets presence updates when something _changes_, not
on a timer, so "no update in N minutes = offline" would have shown every quiet-but-online contact
as offline.

**The failed-message report was half wrong.** I'd said the group tick bug also blocked automatic
re-sending. It never could have — group messages have no auto-resend by design, because the app
can't tell which member failed. The tick problem was real; the re-send claim wasn't.

**One "dead" file wasn't dead.** I'd listed four unused files; one is genuinely used by the vault.
It was kept.

---

## 5. Proof it works, and what's still owed

**Every bug now has a permanent test.** That was your specific ask: from now on these get checked
automatically. Where a fix was in code that can't be run in tests (the message sender, the chat
screen, the recorder), the test reads the source and fails if the fix is removed.

I also **deliberately broke each fix to confirm its test caught it** — a test that passes both
before and after a fix is worthless. Every one went red as expected, then green again when restored.

| Check                | Result                                          |
| -------------------- | ----------------------------------------------- |
| Messenger test suite | **2,677 of 2,678 passing**, run twice           |
| New tests added      | 147, across 11 files                            |
| Type checking        | 47 — exactly the existing baseline, nothing new |
| Code style (lint)    | Clean                                           |

**About that 1 failing test:** it's a pre-existing flaky test, not something I broke. Proof: the
suite that failed was **different on each run** (`safetyNumber` first time, `pushSlimBgHandler` the
second), and both pass fine when run on their own — `safetyNumber` takes 16 seconds alone versus 171
seconds when the machine is loaded. It's a timeout under load. I fixed one real cause of this
flakiness (a build-tool config gap) but it isn't the whole story, so the "run it twice" rule stays.

**Still owed — the honest gap:** none of this has been on a real phone. Unit tests prove the code is
right, not that the feature works. Worth checking when you're back:

1. Reply to a message in a group → the other person should see the quote
2. Record and send a voice note → then play one back and check it isn't quiet
3. Record, then navigate away mid-recording

---

## 6. Where things live

- **Bug details:** `sqa.md` — B-143 to B-154, each with root cause and what was done
- **New rule:** `CLAUDE.md` — the whole messenger suite must be green on every change and every
  push, plus the contract that every future bug needs a regression test
- **Branch:** `fix/messenger-audit-b121` (there's no branch named `fix-messenger-b121` — this is the
  one this work was done on, and the closest match to what you asked for)
