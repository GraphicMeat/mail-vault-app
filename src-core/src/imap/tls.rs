//! The one TLS connect seam for IMAP. `connect` has the same signature on both backends:
//! native-tls (desktop, iOS) and rustls with the platform verifier (Android, or any target
//! with the `tls-rustls` feature).

use std::io;

/// Handshake `stream` as a TLS client for `host`. `all_loopback` relaxes certificate and
/// hostname validation, needed for Proton Mail Bridge's self-signed cert on 127.0.0.1;
/// otherwise validation is always full.
#[cfg(not(any(feature = "tls-rustls", target_os = "android")))]
pub async fn connect<S>(host: &str, stream: S, all_loopback: bool) -> io::Result<TlsStream<S>>
where
    S: futures::io::AsyncRead + futures::io::AsyncWrite + Unpin,
{
    let connector = async_native_tls::TlsConnector::new();
    let connector = if all_loopback {
        connector
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
    } else {
        connector
    };
    connector
        .connect(host, stream)
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))
}

#[cfg(not(any(feature = "tls-rustls", target_os = "android")))]
pub type TlsStream<S> = async_native_tls::TlsStream<S>;

#[cfg(any(feature = "tls-rustls", target_os = "android"))]
pub use rustls_backend::{connect, TlsStream};

#[cfg(any(feature = "tls-rustls", target_os = "android"))]
mod rustls_backend {
    use std::io;
    use std::sync::Arc;

    use futures_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerifier, ServerCertVerified,
    };
    use futures_rustls::rustls::crypto::{ring, CryptoProvider};
    use futures_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use futures_rustls::rustls::{ClientConfig, DigitallySignedStruct, Error, SignatureScheme};
    use rustls_platform_verifier::BuilderVerifierExt;

    pub type TlsStream<S> = futures_rustls::client::TlsStream<S>;

    /// Accepts any certificate. Only ever built for loopback peers (`all_loopback`).
    #[derive(Debug)]
    struct AcceptAny(Arc<CryptoProvider>);

    impl ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            futures_rustls::rustls::crypto::verify_tls12_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            futures_rustls::rustls::crypto::verify_tls13_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    fn client_config(all_loopback: bool) -> Result<ClientConfig, Error> {
        let provider = Arc::new(ring::default_provider());
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?;
        if all_loopback {
            Ok(builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
                .with_no_client_auth())
        } else {
            Ok(builder.with_platform_verifier()?.with_no_client_auth())
        }
    }

    pub async fn connect<S>(host: &str, stream: S, all_loopback: bool) -> io::Result<TlsStream<S>>
    where
        S: futures::io::AsyncRead + futures::io::AsyncWrite + Unpin,
    {
        let config = client_config(all_loopback).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        let name = ServerName::try_from(host.to_string())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        futures_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, stream)
            .await
    }
}
