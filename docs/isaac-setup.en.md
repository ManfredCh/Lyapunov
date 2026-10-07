# Installing and selecting Isaac

[中文](isaac-setup.md)

Lyapunov currently targets Isaac Sim 6.0.1 / 6.0.1.0 with Python 3.12. The default installation prepares MuJoCo. Isaac is optional; ordinary scene work does not require downloading the complete Isaac graphical workstation.

## Use an existing installation

Open **Settings → Physics engines → Isaac → Find local installation**. Discovery checks Isaac environments in older Lyapunov versions, common standalone locations and user Conda environments. It does not scan the entire computer or automatically change your selection.

For an installation you downloaded yourself, enter one of these paths and choose **Check this path**:

- The official standalone installation directory or its `python.sh`.
- A Conda / venv directory containing the matching Isaac SDK, or its `bin/python`.

After a successful check, choose **Use this installation (next startup)**, save and restart the workbench. Module and version discovery does not start Kit, copy an SDK, or update your external environment. An incompatible SDK or Python leaves the existing choice intact, and you can check another path.

## Install through Lyapunov

If you have no suitable installation, read and confirm the NVIDIA license on the same page, then install. Lyapunov uses its own environment with pinned official components and extension caches. It does not change system Python.

The installer saves the SDK path for future product versions only after its own SDK check succeeds. Partial installation, download failure or failure to save the choice is reported explicitly. An existing environment override or saved installation is preserved.

## Which installation is used?

The order is an explicit `LYAPUNOV_ISAAC_PYTHON` override, a saved local installation, then this product version's managed default. Settings display the path and source for the next startup. Saving an SDK does not change a running physics world.

A Lyapunov update does not copy the entire SDK. Keep the selected SDK directory, including an SDK inside an older product version. If you move or delete it, check and register a valid entry again. An invalid explicit choice is reported rather than silently replaced.

## SDK discovery and physics startup

**SDK found** means interpreter, module and version checks passed. An actual world startup, observation and engine state determine whether physics runs. RTX cameras require separate GPU and rendering checks.

NVIDIA lists Ubuntu 22.04 / 24.04 and Windows 11 for the full Isaac runtime, with a compatible RTX GPU and driver. A virtual machine must actually expose the required devices; a GPU on the host does not establish guest access. See [NVIDIA system requirements](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/installation/requirements.html) and the [official Python installation guide](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/installation/install_python.html).

For help, include the product version, installation source and privacy-clean error screenshots when contacting [voryneltech@gmail.com](mailto:voryneltech@gmail.com).
