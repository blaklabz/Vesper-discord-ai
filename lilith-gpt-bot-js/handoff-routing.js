// Factual questions belong to Vesper unless the user explicitly asks for Sable.
// Privileged Gamekeeper operations keep their separate authorization path.
function requestsSableHandoff(content) {
    const text = String(content || '');
    if (/\b(?:do not|don't|dont|never)\s+(?:ask|ping|summon|involve|contact|bother)\s+sable\b/i.test(text)) return false;
    return /\b(?:ask|ping|summon|involve|contact|consult)\s+sable\b/i.test(text) ||
        /\b(?:get|have|let)\s+sable\s+(?:to\s+)?(?:answer|explain|help|handle|research|look|check|join)\b/i.test(text) ||
        /\b(?:hand|pass|send|forward|delegate|turn)\b[^.!?\n]{0,60}\bto\s+sable\b/i.test(text) ||
        /\bbring\s+sable\s+(?:in|into)\b/i.test(text);
}
module.exports = { requestsSableHandoff };
