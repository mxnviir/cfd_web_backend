FROM python:3.11-slim

WORKDIR /app

# cadquery-ocp ships the OCC kernel as wheels but still wants these at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglu1-mesa libxrender1 libxext6 libsm6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Fail the build rather than the first request. OCP is a native extension over
# a kernel that needs system OpenGL, so a missing shared library shows up as an
# ImportError on the import line and nowhere earlier. The specific symbols are
# checked too, because /prepare depends on the surface adaptor and the cylinder
# type, which live in submodules the top-level import does not pull in.
RUN python -c "\
import cadquery, trimesh, flask, firebase_admin; \
from OCP.BRepAdaptor import BRepAdaptor_Surface; \
from OCP.GeomAbs import GeomAbs_SurfaceType; \
from OCP.BRepBndLib import BRepBndLib; \
assert GeomAbs_SurfaceType.GeomAbs_Cylinder is not None; \
print('imports ok')"

COPY main.py .

# Not root.
#
# This process parses STEP, IGES and STL files that arrive from strangers,
# through OpenCascade - a large C++ kernel with a long history of memory-safety
# bugs. Running that as uid 0 means a parser bug owns the container outright.
# services/simscale-job/Dockerfile has done this since it was written.
#
# Nothing here writes to the image: the work happens in a TemporaryDirectory
# under /tmp, which is world-writable, and everything that leaves goes to Cloud
# Storage.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin tessellate
USER 10001

# One worker: geometry work is CPU-bound and memory-hungry, so let Cloud Run
# scale out with instances rather than threads inside one. The timeout covers
# /prepare, where a boolean cut on a detailed car is the slow step.
CMD exec gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 2 --timeout 600 main:app
