"""Pure port definitions; no vendor imports. SPDX-License-Identifier: AGPL-3.0-only"""
from typing import Protocol, Any

class VisualPort(Protocol):
    version: dict[str,Any]
    def inspect(self,image:Any)->dict[str,Any]: ...

class OcrPort(Protocol):
    version: dict[str,Any]
    def read(self,image:Any,corners:Any)->dict[str,Any]: ...
