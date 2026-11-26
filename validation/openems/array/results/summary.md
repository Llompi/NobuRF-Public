# Array far field against openEMS: results

Values are NobuRF / openEMS. Limits are in README.md, set before the runs.

| Array | Drives | Quantity | NobuRF / openEMS | Difference | Result |
| --- | --- | --- | --- | --- | --- |
| dipole_pair | in phase | Peak directivity | 5.49 / 5.79 dBi | -0.30 dB | pass |
| dipole_pair | in phase | Peak direction (theta, phi) | (90, 270) / (90, 90) | 180.0° | fail |
| dipole_pair | in phase | Pattern, phi 0° and 90° cuts | largest difference within 15 dB of peak | 0.37 dB | pass |
| dipole_pair | in phase | Radiation efficiency | 0.997 / 1.076 | -0.078 | fail |
| dipole_pair | in phase | Active reflection |b/a|, port d1 | 0.915 / 0.919 | -0.003 | pass |
| dipole_pair | in phase | Active reflection |b/a|, port d2 | 0.915 / 0.919 | -0.003 | pass |
| dipole_pair | antiphase | Peak directivity | 4.15 / 4.38 dBi | -0.23 dB | pass |
| dipole_pair | antiphase | Peak direction (theta, phi) | (90, 180) / (90, 190) | 10.0° | fail |
| dipole_pair | antiphase | Pattern, phi 0° and 90° cuts | largest difference within 15 dB of peak | 0.24 dB | pass |
| dipole_pair | antiphase | Radiation efficiency | 0.995 / 1.082 | -0.087 | fail |
| dipole_pair | antiphase | Active reflection |b/a|, port d1 | 0.872 / 0.877 | -0.005 | pass |
| dipole_pair | antiphase | Active reflection |b/a|, port d2 | 0.872 / 0.877 | -0.005 | pass |
| patch_pair | in phase | Peak directivity | 8.94 / 8.91 dBi | +0.03 dB | pass |
| patch_pair | in phase | Peak direction (theta, phi) | (0, 0) / (0, 250) | 0.0° | pass |
| patch_pair | in phase | Pattern, phi 0° and 90° cuts | largest difference within 15 dB of peak | 0.18 dB | pass |
| patch_pair | in phase | Radiation efficiency | 1.001 / 0.995 | +0.006 | pass |
| patch_pair | in phase | Active reflection |b/a|, port p1 | 0.249 / 0.219 | +0.030 | pass |
| patch_pair | in phase | Active reflection |b/a|, port p2 | 0.249 / 0.219 | +0.030 | pass |
| patch_pair | antiphase | Peak directivity | 6.82 / 6.81 dBi | +0.01 dB | pass |
| patch_pair | antiphase | Peak direction (theta, phi) | (40, 0) / (40, 0) | 0.0° | pass |
| patch_pair | antiphase | Pattern, phi 0° and 90° cuts | largest difference within 15 dB of peak | 0.14 dB | pass |
| patch_pair | antiphase | Radiation efficiency | 1.000 / 0.996 | +0.004 | pass |
| patch_pair | antiphase | Active reflection |b/a|, port p1 | 0.442 / 0.421 | +0.021 | pass |
| patch_pair | antiphase | Active reflection |b/a|, port p2 | 0.442 / 0.421 | +0.021 | pass |
