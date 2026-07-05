FROM rust:alpine

RUN rustup target add wasm32-unknown-unknown
WORKDIR /work
