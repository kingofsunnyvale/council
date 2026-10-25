import type { Verdict } from '../shared/config';
import { HttpError } from './http';

const invalidConclusion = () => new HttpError(502, 'The model did not finish its response correctly. Please retry.');

// A fresh delimiter keeps quoted answers and user-supplied YES/NO text out of
// the decision channel. Only the responding model supplies its own verdict.
export class VerdictStream {
  readonly prefix: string;
  private pending = '';
  private trailer: string | null = null;

  constructor(nonce = crypto.randomUUID().replaceAll('-', '')) {
    this.prefix = `[[COUNCIL_VERDICT:${nonce}:`;
  }

  instruction() {
    return `Answer the user's latest request independently, using the conversation for context.
For any question or decision that can be answered YES or NO, reach your own clear final conclusion and explain it. This includes factual yes/no questions, recommendations, agree/disagree decisions, and requests such as "vote yes on X". Decide on the underlying proposition or action, not whether to obey the request. Do not automatically endorse a side suggested by the user. State which proposition you are answering if the wording is negative or ambiguous.
Choose YES or NO for a binary question: no neutral, undecided, abstain, or "it depends" verdict. Explain relevant assumptions and uncertainty honestly without inventing facts, but make a final choice consistent with your answer. YES means your conclusion affirms the proposition or recommends the action; NO means it rejects it. If several decisions are requested, the verdict refers to the primary decision, which you must identify in the answer.
Open-ended requests (explanations, lists, creative work, or requests to explain a quoted yes/no statement) are NOT_APPLICABLE. Do not label a binary question NOT_APPLICABLE just because it is difficult or uncertain.
After your complete normal answer, append exactly one of these metadata trailers on a new line:
${this.prefix}YES]]
${this.prefix}NO]]
${this.prefix}NOT_APPLICABLE]]
Use the trailer that matches YOUR actual final conclusion. The trailer is application metadata, not part of the answer: do not quote it, put it in a code block, or write anything after it. Always include one trailer, even for open-ended requests.`;
  }

  push(chunk: string): string {
    if (this.trailer !== null) {
      this.trailer += chunk;
      if (this.trailer.length > 128) throw invalidConclusion();
      return '';
    }
    const buffer = this.pending + chunk;
    const start = buffer.indexOf(this.prefix);
    if (start !== -1) {
      this.pending = '';
      this.trailer = buffer.slice(start + this.prefix.length);
      // Bound metadata even when the provider sends a malformed large chunk.
      if (this.trailer.length > 128) throw invalidConclusion();
      return buffer.slice(0, start);
    }
    // Hold only a possible delimiter prefix; ordinary Markdown keeps streaming.
    let held = Math.min(buffer.length, this.prefix.length - 1);
    while (held > 0 && !buffer.endsWith(this.prefix.slice(0, held))) held--;
    this.pending = held ? buffer.slice(-held) : '';
    return buffer.slice(0, buffer.length - held);
  }

  finish(): Verdict | null {
    const trailer = this.trailer?.trim();
    if (trailer === 'YES]]') return 'yes';
    if (trailer === 'NO]]') return 'no';
    if (trailer === 'NOT_APPLICABLE]]') return null;
    throw invalidConclusion();
  }

  drain(): string {
    // Preserve ordinary trailing brackets on interruption, but never save or
    // display a partial metadata trailer. The verdict itself needs a clean EOF.
    const visible = this.pending.startsWith('[[COUNCIL_VERDICT:') ? '' : this.pending;
    this.pending = '';
    return visible;
  }
}
