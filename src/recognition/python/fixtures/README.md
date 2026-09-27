# Frozen public recognition fixtures

These three files are the exact existing public test images, retained for reproducible builds when the image host is unavailable. They are card catalogue artwork, never customer camera photographs. Their original Scryfall URLs, printing identities and SHA-256 values are recorded in [sources.json](../../../../tests/recognition/sources.json). Card artwork and text belong to their respective owners; these images are test data, not AGPL-licensed application code.

`prepare.py` verifies the same pinned hashes before producing the existing framed smoke-test inputs. It does not replace the images with mocks or change model expectations. The source archive includes these three specific fixtures so an exported build can reproduce them; other local photographs and generated screenshots remain excluded.

`replay_public.py` additionally replays the twelve public cards.scryfall.io images listed in [phone-sources.json](../../../../tests/recognition/phone-sources.json), verifying each downloaded image against its pinned SHA-256 before comparison. Both manifests contain public card artwork only; no camera capture or collection data is stored in the repository.
