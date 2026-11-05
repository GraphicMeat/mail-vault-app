//! The rustls backend of the IMAP TLS seam (`imap::tls::connect`), against a local
//! self-signed acceptor.
#![cfg(feature = "tls-rustls")]

use std::sync::Arc;

use async_std::io::{ReadExt, WriteExt};
use async_std::net::{TcpListener, TcpStream};
use futures_rustls::rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use futures_rustls::rustls::ServerConfig;
use futures_rustls::TlsAcceptor;
use mailvault_core::imap::tls;

/// Echo one byte over TLS with a fresh self-signed cert; returns the server's port.
async fn spawn_echo_server() -> u16 {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])
            .unwrap();
    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivatePkcs8KeyDer::from(signing_key.serialize_der());
    let config = ServerConfig::builder_with_provider(Arc::new(
        futures_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert_der], key_der.into())
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    async_std::task::spawn(async move {
        if let Ok((tcp, _)) = listener.accept().await {
            if let Ok(mut tls) = acceptor.accept(tcp).await {
                let mut b = [0u8; 1];
                if tls.read_exact(&mut b).await.is_ok() {
                    let _ = tls.write_all(&b).await;
                    let _ = tls.flush().await;
                }
            }
        }
    });
    port
}

#[async_std::test]
async fn loopback_accepts_self_signed() {
    let port = spawn_echo_server().await;
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut tls = tls::connect("127.0.0.1", tcp, true).await.expect("loopback handshake");
    tls.write_all(b"x").await.unwrap();
    tls.flush().await.unwrap();
    let mut b = [0u8; 1];
    tls.read_exact(&mut b).await.unwrap();
    assert_eq!(&b, b"x");
}

#[async_std::test]
async fn non_loopback_rejects_self_signed() {
    let port = spawn_echo_server().await;
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let res = tls::connect("localhost", tcp, false).await;
    assert!(res.is_err(), "a self-signed cert must fail full validation");
}
