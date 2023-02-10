import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class MonolithicStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'vpc', {
      vpcName: "sbs-dev-vpc",
      ipAddresses: ec2.IpAddresses.cidr('172.16.0.0/16'),
      natGateways: 2,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'pub',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: 'pri',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
    });

    const webServer = new ec2.Instance(this, "ec2-web", {
      instanceType: new ec2.InstanceType("t2.medium"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: vpc,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
    });
  }
}
