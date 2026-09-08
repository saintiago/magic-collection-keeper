"""One verified image supports Lambda and SageMaker's documented serve command."""

import os
import sys

if sys.argv[1:] == ["serve"]:
    os.execv(sys.executable, [sys.executable, "/var/task/sagemaker_server.py"])
else:
    os.execv("/lambda-entrypoint.sh", ["/lambda-entrypoint.sh", *sys.argv[1:]])
