SPEC

GameStep:
  completion: { mode: physical|answer, acceptable?: string[], allow_note?: bool }
  supporting: {
    gift?: {coins, narrative},
    hint?: {cost, reveal},
    navigator?: {lat,lng,label, hint_only?},
    bonus_animation?: {asset, voice?},
    physical_action?: {desc, confirm_label?}
  }
  media: { task?, character?, hint?, atmosphere? }  // comic roles per page

Templates (primary):
  first, task_no (physical), task_with (answer), continue

Answers:
  list strings from multiline
  client membership match

Physical:
  uniform confirm "I did it"
  optional note + action metadata
  no proof v1

Hints:
  only wrong answer popup on answer task
  no separate button

Coins:
  earn: gifts + task bonuses (snapshot frozen)
  spend: hints (popup only)
  rating: derived net + optional post spend

Feedback:
  FeedbackReport: any page menu "Оставить отзыв" (error, step context)
  Review: post completion rate+comment
  both synced

Bundle:
  full GameSteps + plain acceptable + frozen support + roles comics + nav + anim refs

Locked (08 + client):
- client full local val no reval
- physical uniform confirm
- answers simple multiline
- ctor save+test player
- coins only play
- single buy
- ~5mb
- no branch v1
- event facts progress
- 3 components market/quest/build
- 4 templates primary
- comic per page 4 roles
- nav button optional
- anim voiced bonuses + rating
- popup hints only
- any page feedback

Commerce:
  grant lifetime (pay|coupon|free|admin)
  source audit
  optional per-dl ticket

Version:
  publish = new snapshot
  retain historical for active attempts
  synthetic legacy on import