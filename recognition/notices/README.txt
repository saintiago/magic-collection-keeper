CollectorVision library and Cornelius/Milo models: HanClinto/CollectorVision; model cards identify AGPL-3.0. The user selected AGPL-3.0 for this integration. No alternative commercial grant is required by that choice.
https://github.com/HanClinto/CollectorVision
https://huggingface.co/HanClinto/cornelius
https://huggingface.co/HanClinto/milo

PaddleOCR and the selected detection/Latin recognition weights: PaddlePaddle, Apache-2.0 as specified by the repository and model cards.
https://github.com/PaddlePaddle/PaddleOCR
https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det
https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec

Catalog repository software: CollectorVision Catalog contributors, MIT. Source card metadata/artwork rights are distinct. Magic: The Gathering and card artwork are copyright Wizards of the Coast. This app is not endorsed by Wizards or Scryfall. Retain source attribution; no unrestricted art/data license is claimed.
https://github.com/HanClinto/CollectorVisionCatalog
https://scryfall.com/docs/api

Further Python dependency notices remain in installed package distributions and must be reviewed with the frozen Linux dependency lock before deployment.

Paddle2ONNX (Apache-2.0) converts the original frozen Paddle weights at build time. RapidOCR 3.9.2 (Apache-2.0) supplies detection preprocessing, box extraction, line crops and CTC decoding for the independently replaceable paddle-onnx adapter. The runtime loads only the explicitly supplied converted models and Latin dictionary; it does not use RapidOCR's default models, orientation classifier, font downloads or visualizer.
https://github.com/PaddlePaddle/Paddle2ONNX
https://github.com/RapidAI/RapidOCR

