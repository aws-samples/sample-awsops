FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
COPY image-requirements.txt /codec/image-requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /codec/image-requirements.txt
COPY render_head_image.py image-formats.json /codec/
RUN chmod -R a-w /codec
USER 65532:65532
WORKDIR /codec
ENTRYPOINT ["python", "-I", "/codec/render_head_image.py"]
