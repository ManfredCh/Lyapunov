---
license: cc-by-4.0
language:
- en
tags:
- 3D
- simready
- warehouse
- NVIDIA
pretty_name: NVIDIA Physical AI SimReady Warehouse OpenUDS Dataset
size_categories:
- n<1K
task_categories:
- image-segmentation
- robotics
- depth-estimation
- object-detection
- image-classification
- image-feature-extraction
download_size: 10132336442
dataset_size: 10132336442
configs:
- config_name: default
  data_files: physical_ai_simready_warehouse_01.csv
  image_field: asset_preview
---

# NVIDIA Physical AI SimReady Warehouse OpenUSD Dataset

![Physical AI SimReady Warehouse Dataset Preview](./images/PhysicalAI_Dataset_01.png)

![Hand Manipulation Assets Preview](./images/ComputexWarehouse_physical_ai.png)

**Dataset Version:** 1.1.0<br>
**Date:** May 18, 2025<br>
**Author:** NVIDIA, Corporation
**License:** [CC-BY-4.0](https://choosealicense.com/licenses/cc-by-4.0/) (Creative Commons Attribution 4.0 International)

## Contents
This dataset includes the following:
* This README file
* A CSV catalog that enumerates all of the OpenUSD assets that are part of this dataset including a sub-folder of images that showcase each 3D asset ([physical_ai_simready_warehouse_01.csv](./physical_ai_simready_warehouse_01.csv)). The CSV file is organized in the following manner:
    * asset_preview : A visual preview (thumbnail) of the asset
    * asset_name : Name of the asset
    * relative_path: location within archive of the asset Usd file
    * classification: Asset Classification (Prop, Scenario, Assembly, etc.)
    * label: Label name of q-code in English.
    * q_code: Semantic Label (derived from [WikiData](https://wikidata.org) Q-Code)
    * mass(kg): Approximate mass of the object in kilograms
    * thumbnail_path: path to an image thumbnail (PNG format)
* 753 OpenUSD 3D assets that are compatible with NVIDIA's IsaacSim application for simulation. The dataset archive is approximately 15GB in size.
* The 1.1.0 version of the dataset now includes an entire section of physically graspable objects for robotic pick and place testing.


## Prerequisites
This dataset is intended for use within [NVIDIA IsaacSim](https://developer.nvidia.com/isaac/sim) version 4.x, and depicts an industrial warehouse environment.<br>

For users who are new to OpenUSD as a format, NVIDIA encourages the following learning resources to get you started:

* **Learn OpenUSD**: https://docs.nvidia.com/learn-openusd/latest/index.html

For users who are new to IsaacSim and simulation, and want to learn how to add robots to your scenes (including the [scenario in this dataset](./physical_ai_simready_warehouse_01.usd)), here are some additional learning resources to explore:

* [**Learning Path: Robotics Fundamentals**](https://www.nvidia.com/en-us/learn/learning-path/robotics/)
* [**IsaacSim: Quickstart with a Robot**](https://docs.isaacsim.omniverse.nvidia.com/latest/introduction/quickstart_isaacsim_robot.html)
* **IsaacSim: ROS 2 Tutorials**:
    * [**ROS 2 Navigation**](https://docs.isaacsim.omniverse.nvidia.com/latest/ros2_tutorials/tutorial_ros2_navigation.html)
    * [**ROS 2 Joint Control**](https://docs.isaacsim.omniverse.nvidia.com/latest/ros2_tutorials/tutorial_ros2_manipulation.html)

## How to Use


### Adding Rigid Body Physics to the Dataset Assets
To begin, open the [**physical_ai_simready_warehouse_01.usd**](./physical_ai_simready_warehouse_01.usd) file that is in the root of the dataset archive. This is a complete warehouse scene that has been pre-built as a starting point for simulation. This scene file uses OpenUSD composition arcs to payload in many other individual OpenUSD files.<br>

- **NOTE:** The initial load of this file might take several minutes as IsaacSim will need to compile all of the materials and physics colliders.

All of the 3D assets in this scene have USDPhysics Colliders applied, **but no Rigid Bodies are applied**. It is up to the user to add rigid body physics to individual assets as desired to satisfy their simulation goals. The application of a rigid body to an asset will determine if it should fall with gravity, collide with other assets and be interactive with other elements in the scene like a robot.

To add Rigid Bodies to an asset, do the following within IsaacSim.

1. Select any asset you wish to apply Rigid Bodies to in the Stage Panel. Be sure to select the top-level payload XForm prim that represents the entire 3D asset, not one of the geometry or material prims within it.

   <img src="./images/PhysicalAI_Dataset_02.png" alt="Physical AI Dataset Preview" width="50%"/>

2. In the Properties Panel, disable the **Instanceable** checkbox to make the asset unique.

3. Next, in the Properties Panel, click **Add -> Physics -> Rigid Body** to add the RBD physics to the asset.

   <img src="./images/PhysicalAI_Dataset_03.png" alt="Physical AI Dataset Preview" width="50%"/>

4. Repeat this process for each asset you want to interact with when a simulation is run.

5. When the assets are configured with Rigid Body Dynamics, hit the **Play** button in IsaacSim to begin the simulation.

### Asset Classifications

* **Prop**: A single object that can be placed in a scene.
* **Assembly**: A collection of props that can be placed in a scene as a logical group.
* **Scenario**: A collection of props and assemblies to make an environment for simulation. (ex: A warehouse)


### Additional Questions
If you have additional questions, you are encouraged to join our [**NVIDIA Omniverse Discord channel**](https://discord.com/invite/nvidiaomniverse) to interact with other Omniverse and IsaacSim users.