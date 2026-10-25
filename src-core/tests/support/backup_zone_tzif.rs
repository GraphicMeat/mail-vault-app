// Synthetic complete TZif v1 rules, with a summer interval. Test data only.
pub fn tzif(standard: i32) -> Vec<u8> {
    let mut bytes = b"TZif\0".to_vec();
    bytes.extend([0; 15]);
    for count in [0u32, 0, 0, 2, 2, 8] {
        bytes.extend(count.to_be_bytes());
    }
    for transition in [1_700_000_000i32, 1_800_000_000] {
        bytes.extend(transition.to_be_bytes());
    }
    bytes.extend([1, 0]);
    bytes.extend(standard.to_be_bytes());
    bytes.extend([0, 0]);
    bytes.extend((standard + 3600).to_be_bytes());
    bytes.extend([1, 4]);
    bytes.extend(b"STD\0DST\0");
    bytes
}
