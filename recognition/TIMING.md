# Recognition timing records

`recognitionTiming` schema 1 contains a random processId, monotonic processAgeMs,
event, and a validated AWS UUID requestId when the Lambda handler has started.
Startup records have a fixed allowlisted stage, start/end, elapsedMs and ok. They
are emitted immediately, including while preparing models inside a request, so
a timeout retains the last unfinished stage. Library INIT cannot know the future
AWS request ID; correlate its process ID and CloudWatch log stream with START.

Every handler invocation emits request-start with modelsReady and request-end
with elapsedMs and a bounded map of stage totals (ms, calls, ok). Repeated OCR
line batches aggregate instead of emitting a log per line. Timers nest: component
times must not be added to their parent total. visual.detect/embed include provider
pre/postprocessing; their nested *_inference times isolate actual ONNX execution.
OCR records dewarp/crops, detection, normalization, inference and postprocessing.
File stages cover digest verification; catalog covers verified loading/decompression
and reference construction; *_session covers provider session construction.

Only fixed stage names, numeric measurements, booleans and generated/validated
correlation identifiers enter these records. No input/output text, image bytes,
card identities, owner identifiers, exception strings, credentials or tokens are
accepted. Timing tests exercise aggregation, partial startup, error privacy and
transparent provider calls. Existing source offer and seven-day logs remain.

After timeout, repeated process IDs or a reused log stream do not alone establish
warmth. A new processId plus import/prepare records means initialization restarted.
modelsReady true with no preparation stages and subsequent successful inference
is evidence of model reuse. A new image's first call remains separately labelled
from recovery after earlier image file reads and from later warm calls.
