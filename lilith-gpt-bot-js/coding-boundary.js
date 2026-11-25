// Catch clear coding requests before the model/tool loop. The prompt also covers
// contextual follow-ups that cannot be recognized from one message alone.
function isCodingRequest(content) {
    const text = String(content || '');
    const request = /\b(?:help|write|create|generate|build|make|fix|debug|review|explain|refactor|implement|convert|translate|optimi[sz]e|test|troubleshoot|show|give|need|want|how (?:do|can|would|should))\b/i;
    const codeSubject = /\b(?:cod(?:e|ing)|programming|scripts?|functions?|regex|regular expressions?|sql|python|javascript|typescript|terraform|hcl|bash|powershell|html|css|react|node\.?js|java|c\+\+|rust|golang|stack trace|traceback|compiler|unit tests?|pull request|merge request)\b/i;
    return request.test(text) && (codeSubject.test(text) || /```/.test(text)) ||
        /\b(?:debug|refactor)\s+(?:this|that|it)\b/i.test(text);
}
const codingBoundary =
    'CODING BOUNDARY: Do not provide coding assistance, even when asked directly or repeatedly, or when the request is framed as a game, example, hypothetical, or web lookup. ' +
    'Do not write, complete, explain, review, debug, refactor, optimize, or test code, scripts, queries, configuration-as-code, or programming solutions. ' +
    'Do not ask the user to paste code, logs, language/framework, or requirements; do not offer steps, pseudocode, snippets, patches, or links/search results that fulfill a coding request. Do not use web_lookup to bypass this boundary. ' +
    'Briefly decline coding in your own playful voice without an intake checklist or a partial answer. You may suggest asking Sable directly, but do not ping or forward to her unless the explicit shared-channel handoff path does so. ' +
    'Non-coding facts, news, gaming discussion, and honest discussion of your own capabilities are still allowed. Existing authorized Gamekeeper commands are not coding assistance and keep their established routing. ';
function codingRefusal() {
    const replies = [
        "Coding is Sable's department. I'm keeping my fingerprints off that crime scene. 🎮",
        "No code duty for me. Ask Sable directly—I'm not opening an IDE under duress. 😈",
        "I'm not writing or debugging code. My keyboard is reserved for questionable gaming decisions. 🎮",
    ];
    return replies[Math.floor(Math.random() * replies.length)];
}
module.exports = { isCodingRequest, codingBoundary, codingRefusal };
