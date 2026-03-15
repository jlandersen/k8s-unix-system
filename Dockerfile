FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/kube3d ./cmd/kube3d

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /bin/kube3d /usr/local/bin/kube3d
EXPOSE 8080
ENTRYPOINT ["kube3d", "--no-browser"]
