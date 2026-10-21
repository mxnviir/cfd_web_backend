FROM python:3.11-slim

WORKDIR /app

# git: the SimScale SDK is only published on GitHub.
# The rest: pyvista pulls in VTK, which links against system OpenGL and X11
# libraries even when it never opens a window. Without them `import pyvista`
# fails with a bare "libGL.so.1: cannot open shared object file", and the run
# gets that far only after the solve has finished — so the whole simulation is
# paid for and then thrown away at the export step.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git libgl1 libglx-mesa0 libxrender1 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Fail the build, not a run. pyvista and trimesh are imported inside the export
# step, which happens after the solve — so a missing shared library or a bad
# pin would otherwise surface only once a simulation had been paid for and
# finished, and then throw the results away.
RUN python -c "import firebase_admin, simscale_sdk, requests, numpy, trimesh, pyvista; print('imports ok')"

# Both modules, not just the entry point. simscale_job.py imports spec_mode at
# the top, so a build that copies only the entry point produces an image that
# dies on `import spec_mode` before it can mark the job failed. Found that way
# on 11 Sep 2026.
COPY simscale_job.py spec_mode.py ./

# VTK looks for a display. There is not one here, and the default is to try
# anyway and abort.
ENV PYVISTA_OFF_SCREEN=true \
    LIBGL_ALWAYS_SOFTWARE=1 \
    PYTHONUNBUFFERED=1

# Nothing here needs root, and the job downloads and parses files a user
# supplied.
RUN useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /app
USER worker

CMD ["python", "simscale_job.py"]
